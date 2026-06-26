const express = require('express');
const app = express()
const port = process.env.PORT || 5000
const cors = require('cors')
require('dotenv').config()
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.use(cors())
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Hello World!')
})




const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = process.env.MONGODB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db("taskly-db");
        const tasksCollection = db.collection("tasks");
        const freelancersCollection = db.collection("freelancers");
        const proposalsCollection = db.collection("proposals");
        const paymentsCollection = db.collection("payments");
        const userCollection = db.collection("user");
        const ratingsCollection = db.collection("ratings");
        const freelancerRatingsCollection = db.collection("freelancer_ratings");

        // ─── Shared session helper ───────────────────────────────────────────
        async function resolveSessionUser(req) {
            let token = req.headers.authorization?.split(' ')[1];
            if (!token) {
                const cookies = req.headers.cookie || '';
                const sessionCookieMatch = cookies.match(/better-auth\.session_token=([^;]+)/);
                if (sessionCookieMatch) {
                    token = sessionCookieMatch[1];
                }
            }
            if (!token) return null;

            const sessionDoc = await db.collection("session").findOne({ token });
            if (!sessionDoc) return null;

            const userDoc = await userCollection.findOne({ _id: sessionDoc.userId });
            if (!userDoc || userDoc.isBlocked) return null;

            return userDoc;
        }

        async function getClientRatingStats(clientId) {
            if (!clientId) return { average: 0, count: 0 };
            const ratings = await ratingsCollection.find({ clientId: clientId.toString() }).toArray();
            if (!ratings.length) return { average: 0, count: 0 };
            const sum = ratings.reduce((acc, r) => acc + Number(r.stars || 0), 0);
            return { average: sum / ratings.length, count: ratings.length };
        }

        async function getFreelancerRatingStats(freelancerEmail) {
            if (!freelancerEmail) return { average: 0, count: 0 };
            const normalized = freelancerEmail.toLowerCase();
            const ratings = await freelancerRatingsCollection.find({ freelancerEmail: normalized }).toArray();
            if (!ratings.length) return { average: 0, count: 0 };
            const sum = ratings.reduce((acc, r) => acc + Number(r.stars || 0), 0);
            return { average: sum / ratings.length, count: ratings.length };
        }

        async function syncFreelancerRating(email) {
            if (!email) return { average: 0, count: 0 };
            const stats = await getFreelancerRatingStats(email);
            const emailRegex = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
            await userCollection.updateOne(
                { email: emailRegex },
                { $set: { rating: stats.average } }
            );
            return stats;
        }

        /** Count completed gigs per freelancer email from proposals + tasks (source of truth). */
        async function getCompletedJobsByEmail() {
            const completedTasks = await tasksCollection
                .find({ status: { $regex: /^completed$/i } })
                .project({ _id: 1 })
                .toArray();
            const completedTaskIds = new Set(completedTasks.map(t => t._id.toString()));

            const acceptedProposals = await proposalsCollection
                .find({ status: { $regex: /^accepted$/i } })
                .project({ taskId: 1, freelancerEmail: 1 })
                .toArray();

            const counts = {};
            for (const proposal of acceptedProposals) {
                const taskId = proposal.taskId?.toString();
                const email = (proposal.freelancerEmail || '').toLowerCase();
                if (!email || !taskId || !completedTaskIds.has(taskId)) continue;
                counts[email] = (counts[email] || 0) + 1;
            }
            return counts;
        }

        /** Persist computed count onto user documents. */
        async function syncFreelancerCompletedJobs(email, count) {
            if (!email) return;
            const normalized = email.toLowerCase();
            await userCollection.updateOne(
                { email: { $regex: new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
                { $set: { completedJobs: count } }
            );
        }

        /** When a task is marked completed, bump the assigned freelancer's cached count. */
        async function incrementFreelancerCompletedJobs(taskId) {
            const proposal = await proposalsCollection.findOne({
                taskId: taskId.toString(),
                status: { $regex: /^accepted$/i },
            });
            if (!proposal?.freelancerEmail) return;

            const emailRegex = new RegExp(
                `^${proposal.freelancerEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
                'i'
            );
            await userCollection.updateOne(
                { email: emailRegex },
                { $inc: { completedJobs: 1 } }
            );
        }








        app.post('/api/tasks', async (req, res) => {
            const task = req.body;

            const newTask = {
                ...task,
                createdAt: new Date(),
            }

            const result = await tasksCollection.insertOne(newTask);

            res.send(result);
        });


        //  getting the tasks by id (supports both clientId list and single task _id)
        app.get('/api/tasks/:id', async (req, res) => {
            const id = req.params.id;

            try {
                // 1. Try to find tasks where clientId matches this ID
                const tasks = await tasksCollection.find({ clientId: id }).toArray();
                if (tasks && tasks.length > 0) {
                    const tasksWithCounts = await Promise.all(tasks.map(async (t) => {
                        const count = await proposalsCollection.countDocuments({ taskId: t._id.toString() });
                        const proposal = await proposalsCollection.findOne({ taskId: t._id.toString(), status: { $regex: /^accepted$/i } });
                        let freelancerEmail = null;
                        let freelancerName = null;
                        let freelancerImage = null;
                        if (proposal) {
                            freelancerEmail = proposal.freelancerEmail;
                            const freelancerUser = await userCollection.findOne({ email: proposal.freelancerEmail });
                            if (freelancerUser) {
                                freelancerName = freelancerUser.name || freelancerUser.displayName || 'Freelancer';
                                freelancerImage = freelancerUser.image || freelancerUser.avatarUrl || null;
                            }
                        }
                        return { 
                            ...t, 
                            proposals: count,
                            freelancerEmail,
                            freelancerName,
                            freelancerImage
                        };
                    }));
                    return res.send(tasksWithCounts);
                }

                // 2. If no tasks found by clientId, try to find a single task by its task _id
                if (ObjectId.isValid(id)) {
                    const task = await tasksCollection.findOne({
                        _id: new ObjectId(id),
                    });
                    if (task) {
                        const count = await proposalsCollection.countDocuments({ taskId: task._id.toString() });
                        const proposal = await proposalsCollection.findOne({ taskId: task._id.toString(), status: { $regex: /^accepted$/i } });
                        let freelancerEmail = null;
                        let freelancerName = null;
                        let freelancerImage = null;
                        if (proposal) {
                            freelancerEmail = proposal.freelancerEmail;
                            const freelancerUser = await userCollection.findOne({ email: proposal.freelancerEmail });
                            if (freelancerUser) {
                                freelancerName = freelancerUser.name || freelancerUser.displayName || 'Freelancer';
                                freelancerImage = freelancerUser.image || freelancerUser.avatarUrl || null;
                            }
                        }
                        return res.send({ 
                            ...task, 
                            proposals: count,
                            freelancerEmail,
                            freelancerName,
                            freelancerImage
                        });
                    }
                }

                // Return empty array if no tasks found
                res.send([]);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // update task by id
        app.put('/api/tasks/:id', async (req, res) => {
            const id = req.params.id;
            const updatedTask = req.body;

            try {
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ error: 'Invalid task ID.' });
                }

                const prevTask = await tasksCollection.findOne({ _id: new ObjectId(id) });
                if (!prevTask) {
                    return res.status(404).send({ error: 'Task not found.' });
                }

                const prevCompleted = prevTask.status?.toLowerCase() === 'completed';
                const nowCompleted = updatedTask.status?.toLowerCase() === 'completed';

                const updateFields = { ...updatedTask };
                if (nowCompleted && !prevCompleted) {
                    updateFields.completedAt = new Date();
                    await incrementFreelancerCompletedJobs(id);
                }

                const result = await tasksCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updateFields }
                );

                res.send(result);
            } catch (error) {
                res.status(400).send({ error: 'Invalid ID' });
            }
        });

        // delete task by id
        app.delete('/api/tasks/:id', async (req, res) => {
            const id = req.params.id;

            try {
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ error: 'Invalid task ID format.' });
                }

                // Authentication & authorization
                let token = req.headers.authorization?.split(' ')[1];
                if (!token) {
                    const cookies = req.headers.cookie || '';
                    const sessionCookieMatch = cookies.match(/better-auth\.session_token=([^;]+)/);
                    if (sessionCookieMatch) {
                        token = sessionCookieMatch[1];
                    }
                }

                if (!token) {
                    return res.status(401).send({ error: 'Unauthorized: Session token required.' });
                }

                const sessionDoc = await db.collection("session").findOne({ token });
                if (!sessionDoc) {
                    return res.status(401).send({ error: 'Unauthorized: Invalid session.' });
                }

                const userDoc = await db.collection("user").findOne({ _id: sessionDoc.userId });
                if (!userDoc || userDoc.isBlocked) {
                    return res.status(403).send({ error: 'Forbidden: Account is blocked.' });
                }

                // Admins can delete any task
                if (userDoc.role === 'admin') {
                    const result = await tasksCollection.deleteOne({ _id: new ObjectId(id) });
                    return res.send(result);
                }

                // Clients can delete only their own task
                const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
                if (!task) {
                    return res.status(404).send({ error: 'Task not found.' });
                }

                if (task.clientId !== userDoc._id.toString()) {
                    return res.status(403).send({ error: 'Forbidden: You do not own this task.' });
                }

                // Delete only permitted if no proposal has been accepted (i.e. status is open)
                const acceptedProposal = await db.collection("proposals").findOne({ taskId: id, status: 'accepted' });
                if (acceptedProposal || task.status !== 'open') {
                    return res.status(400).send({ error: 'Forbidden: Cannot delete a task after a proposal has been accepted.' });
                }

                const result = await tasksCollection.deleteOne({ _id: new ObjectId(id) });
                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // get all the tasks (supports filters & pagination)
        app.get('/api/tasks', async (req, res) => {
            try {
                const { page, limit, search, category, minBudget, sort } = req.query;

                // Build query object
                const query = {};
                if (search) {
                    query.$or = [
                        { title: { $regex: search, $options: 'i' } },
                        { description: { $regex: search, $options: 'i' } }
                    ];
                }
                if (category && category !== 'All Categories') {
                    query.category = category;
                }
                if (minBudget) {
                    query.budget = { $gte: Number(minBudget) };
                }

                // Build sort options
                const sortOptions = {};
                if (sort === 'newest') {
                    sortOptions.createdAt = -1;
                } else if (sort === 'budget-high') {
                    sortOptions.budget = -1;
                } else if (sort === 'budget-low') {
                    sortOptions.budget = 1;
                } else if (sort === 'deadline') {
                    sortOptions.deadline = 1;
                } else {
                    sortOptions.createdAt = -1;
                }

                if (page || limit) {
                    const pageNum = parseInt(page) || 1;
                    const limitNum = parseInt(limit) || 9;
                    const skipNum = (pageNum - 1) * limitNum;

                    const total = await tasksCollection.countDocuments(query);
                    const result = await tasksCollection.find(query)
                        .sort(sortOptions)
                        .skip(skipNum)
                        .limit(limitNum)
                        .toArray();

                    const tasksWithCounts = await Promise.all(result.map(async (t) => {
                        const count = await proposalsCollection.countDocuments({ taskId: t._id.toString() });
                        const proposal = await proposalsCollection.findOne({ taskId: t._id.toString(), status: { $regex: /^accepted$/i } });
                        let freelancerEmail = null;
                        let freelancerName = null;
                        let freelancerImage = null;
                        if (proposal) {
                            freelancerEmail = proposal.freelancerEmail;
                            const freelancerUser = await userCollection.findOne({ email: proposal.freelancerEmail });
                            if (freelancerUser) {
                                freelancerName = freelancerUser.name || freelancerUser.displayName || 'Freelancer';
                                freelancerImage = freelancerUser.image || freelancerUser.avatarUrl || null;
                            }
                        }
                        return { 
                            ...t, 
                            proposals: count,
                            freelancerEmail,
                            freelancerName,
                            freelancerImage
                        };
                    }));

                    res.send({
                        tasks: tasksWithCounts,
                        total,
                        page: pageNum,
                        limit: limitNum,
                        totalPages: Math.ceil(total / limitNum)
                    });
                } else {
                    const result = await tasksCollection.find(query).sort(sortOptions).toArray();
                    const tasksWithCounts = await Promise.all(result.map(async (t) => {
                        const count = await proposalsCollection.countDocuments({ taskId: t._id.toString() });
                        const proposal = await proposalsCollection.findOne({ taskId: t._id.toString(), status: { $regex: /^accepted$/i } });
                        let freelancerEmail = null;
                        let freelancerName = null;
                        let freelancerImage = null;
                        if (proposal) {
                            freelancerEmail = proposal.freelancerEmail;
                            const freelancerUser = await userCollection.findOne({ email: proposal.freelancerEmail });
                            if (freelancerUser) {
                                freelancerName = freelancerUser.name || freelancerUser.displayName || 'Freelancer';
                                freelancerImage = freelancerUser.image || freelancerUser.avatarUrl || null;
                            }
                        }
                        return { 
                            ...t, 
                            proposals: count,
                            freelancerEmail,
                            freelancerName,
                            freelancerImage
                        };
                    }));
                    res.send(tasksWithCounts);
                }
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });



        //  freelancers — get data from userCollection based on role 'freelancer'
        app.get('/api/freelancers', async (req, res) => {
            try {
                const completedJobsByEmail = await getCompletedJobsByEmail();

                // Fetch all users who signed up as freelancers
                const userFreelancers = await userCollection
                    .find({ role: 'freelancer' })
                    .project({ password: 0 })
                    .toArray();

                const withDynamicJobs = (freelancer) => {
                    const email = (freelancer.email || '').toLowerCase();
                    const dynamicCount = completedJobsByEmail[email] ?? 0;
                    return {
                        ...freelancer,
                        completedJobs: dynamicCount,
                    };
                };

                const freelancers = userFreelancers.map(u => withDynamicJobs({
                    _id:           u._id,
                    name:          u.name          || u.displayName || 'Freelancer',
                    email:         u.email         || '',
                    title:         u.title         || u.role        || 'Freelancer',
                    image:         u.image         || u.avatarUrl   || null,
                    skills:        Array.isArray(u.skills) ? u.skills : (typeof u.skills === 'string' ? u.skills.split(',').map(s => s.trim()).filter(Boolean) : []),
                    bio:           u.bio           || '',
                    rating:        Number(u.rating)        || 0,
                    emailVerified: u.emailVerified === true,
                    isVerified:    u.isVerified === true,
                    source:        'user',
                    completedJobs: 0,
                }));

                // Keep user documents in sync (fire-and-forget)
                freelancers.forEach(f => {
                    if (f.email) syncFreelancerCompletedJobs(f.email, f.completedJobs).catch(() => {});
                });

                const sorted = freelancers.sort((a, b) => {
                    const ratingDiff = (b.rating || 0) - (a.rating || 0);
                    if (ratingDiff !== 0) return ratingDiff;
                    return (b.completedJobs || 0) - (a.completedJobs || 0);
                });

                res.send(sorted);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // Get single freelancer profile by email
        app.get('/api/freelancers/:email', async (req, res) => {
            try {
                const email = req.params.email.toLowerCase().trim();
                const u = await userCollection.findOne({ email, role: 'freelancer' });
                if (!u) {
                    return res.status(404).send({ error: 'Freelancer not found.' });
                }
                const completedJobsByEmail = await getCompletedJobsByEmail();
                const dynamicCount = completedJobsByEmail[email] ?? 0;
                const freelancer = {
                    _id:           u._id,
                    name:          u.name          || u.displayName || 'Freelancer',
                    email:         u.email         || '',
                    title:         u.title         || u.role        || 'Freelancer',
                    image:         u.image         || u.avatarUrl   || null,
                    skills:        Array.isArray(u.skills) ? u.skills : (typeof u.skills === 'string' ? u.skills.split(',').map(s => s.trim()).filter(Boolean) : []),
                    bio:           u.bio           || '',
                    rating:        Number(u.rating)        || 0,
                    emailVerified: u.emailVerified === true,
                    isVerified:    u.isVerified === true,
                    source:        'user',
                    completedJobs: dynamicCount,
                };
                res.send(freelancer);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // Freelancer earnings endpoint
        app.get('/api/freelancer/earnings', async (req, res) => {
            try {
                const userDoc = await resolveSessionUser(req);
                if (!userDoc) {
                    return res.status(401).send({ error: 'Unauthorized: Valid session required.' });
                }
                if (userDoc.role !== 'freelancer') {
                    return res.status(403).send({ error: 'Forbidden: Only freelancers can check earnings.' });
                }

                const email = userDoc.email.toLowerCase().trim();
                const proposals = await proposalsCollection.find({
                    freelancerEmail: email,
                    status: { $regex: /^accepted$/i }
                }).toArray();

                const earnings = [];
                let totalEarnings = 0;

                for (const prop of proposals) {
                    const task = await tasksCollection.findOne({ _id: new ObjectId(prop.taskId) });
                    if (task && task.status?.toLowerCase() === 'completed') {
                        // Resolve client details
                        let clientName = task.clientName || 'Client';
                        if (!task.clientName && task.clientId) {
                            try {
                                const clientUser = await userCollection.findOne({ _id: new ObjectId(task.clientId) });
                                if (clientUser) {
                                    clientName = clientUser.name || clientUser.displayName || 'Client';
                                }
                            } catch (_) {
                                const clientUser = await userCollection.findOne({ _id: task.clientId });
                                if (clientUser) {
                                    clientName = clientUser.name || clientUser.displayName || 'Client';
                                }
                            }
                        }

                        const amount = prop.proposedBudget || task.budget || 0;
                        earnings.push({
                            _id: task._id.toString(),
                            taskTitle: task.title,
                            clientName,
                            amountMade: amount,
                            completionDate: task.completedAt || task.updatedAt || prop.submittedAt || new Date()
                        });
                        totalEarnings += amount;
                    }
                }

                // Sort by completion date descending
                earnings.sort((a, b) => new Date(b.completionDate) - new Date(a.completionDate));

                res.send({
                    earnings,
                    stats: {
                        totalEarnings,
                        completedCount: earnings.length
                    }
                });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // Logged-in freelancer stats (dynamic completed job count)
        app.get('/api/freelancers/me/stats', async (req, res) => {
            try {
                const userDoc = await resolveSessionUser(req);
                if (!userDoc) {
                    return res.status(401).send({ error: 'Unauthorized: Valid session required.' });
                }
                if (userDoc.role !== 'freelancer') {
                    return res.status(403).send({ error: 'Forbidden: Freelancer account required.' });
                }

                const completedJobsByEmail = await getCompletedJobsByEmail();
                const email = (userDoc.email || '').toLowerCase();
                const completedJobs = completedJobsByEmail[email] ?? 0;

                await syncFreelancerCompletedJobs(userDoc.email, completedJobs);

                res.send({
                    completedJobs,
                    totalProposals: await proposalsCollection.countDocuments({ freelancerEmail: userDoc.email }),
                    acceptedProposals: await proposalsCollection.countDocuments({
                        freelancerEmail: userDoc.email,
                        status: { $regex: /^accepted$/i },
                    }),
                });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });



        // proposals — submit a proposal
        app.post('/api/proposals', async (req, res) => {
            try {
                const { taskId, freelancerEmail, proposedBudget, estimatedDays, coverNote, userId, taskTitle } = req.body;

                if (!taskId || !freelancerEmail || !proposedBudget || !estimatedDays || !coverNote) {
                    return res.status(400).send({ error: 'All fields are required.' });
                }

                const proposal = {
                    taskId,
                    taskTitle:       taskTitle  || null,
                    freelancerEmail,
                    userId:          userId     || null,
                    proposedBudget:  Number(proposedBudget),
                    estimatedDays:   Number(estimatedDays),
                    coverNote,
                    status:          'pending',
                    submittedAt:     new Date(),
                };

                const result = await proposalsCollection.insertOne(proposal);
                res.status(201).send({ insertedId: result.insertedId, message: 'Proposal submitted successfully.' });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // proposals — get a single proposal by ID
        app.get('/api/proposals/:id', async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ error: 'Invalid proposal ID format.' });
                }
                const proposal = await proposalsCollection.findOne({ _id: new ObjectId(id) });
                if (!proposal) {
                    return res.status(404).send({ error: 'Proposal not found.' });
                }
                res.send(proposal);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // proposals — get proposals by freelancer email
        app.get('/api/proposals', async (req, res) => {
            try {
                const { email, freelancerEmail } = req.query;
                let targetEmail = freelancerEmail || email;

                if (targetEmail === 'mine') {
                    // Resolve 'mine' using the Better-Auth session token
                    let token = req.headers.authorization?.split(' ')[1];
                    if (!token) {
                        const cookies = req.headers.cookie || '';
                        const sessionCookieMatch = cookies.match(/better-auth\.session_token=([^;]+)/);
                        if (sessionCookieMatch) {
                            token = sessionCookieMatch[1];
                        }
                    }

                    if (token) {
                        const sessionDoc = await db.collection("session").findOne({ token });
                        if (sessionDoc) {
                            const userDoc = await db.collection("user").findOne({ _id: sessionDoc.userId });
                            if (userDoc && !userDoc.isBlocked) {
                                targetEmail = userDoc.email;
                            }
                        }
                    }
                }

                if (targetEmail === 'mine') {
                    return res.status(401).send({ error: 'Unauthorized: Could not identify the freelancer from session or user is blocked.' });
                }

                const filter = targetEmail ? { freelancerEmail: targetEmail } : {};
                const proposals = await proposalsCollection.find(filter).sort({ submittedAt: -1 }).toArray();
                res.send(proposals);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // proposals — get proposals submitted to this client's tasks
        app.get('/api/client/proposals', async (req, res) => {
            try {
                let token = req.headers.authorization?.split(' ')[1];
                if (!token) {
                    const cookies = req.headers.cookie || '';
                    const sessionCookieMatch = cookies.match(/better-auth\.session_token=([^;]+)/);
                    if (sessionCookieMatch) {
                        token = sessionCookieMatch[1];
                    }
                }

                if (!token) {
                    return res.status(401).send({ error: 'Unauthorized: Session token required.' });
                }

                const sessionDoc = await db.collection("session").findOne({ token });
                if (!sessionDoc) {
                    return res.status(401).send({ error: 'Unauthorized: Invalid session.' });
                }

                const userDoc = await db.collection("user").findOne({ _id: sessionDoc.userId });
                if (!userDoc || userDoc.isBlocked) {
                    return res.status(403).send({ error: 'Forbidden: Account is blocked.' });
                }
                if (userDoc.role !== 'client') {
                    return res.status(403).send({ error: 'Forbidden: Only clients can view client proposals.' });
                }

                const clientId = userDoc._id.toString();

                // Find all tasks posted by this client
                const tasks = await tasksCollection.find({ clientId }).toArray();
                if (!tasks || tasks.length === 0) {
                    return res.send([]);
                }

                const taskIds = tasks.map(t => t._id.toString());

                // Find all proposals for these tasks
                const proposals = await proposalsCollection.find({ taskId: { $in: taskIds } }).sort({ submittedAt: -1 }).toArray();
                res.send(proposals);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // proposals — update status of a proposal (accept/reject)
        app.patch('/api/proposals/:id/status', async (req, res) => {
            try {
                const { id } = req.params;
                const { status } = req.body;

                if (!['accepted', 'rejected', 'pending'].includes(status)) {
                    return res.status(400).send({ error: 'Invalid status value.' });
                }

                let token = req.headers.authorization?.split(' ')[1];
                if (!token) {
                    const cookies = req.headers.cookie || '';
                    const sessionCookieMatch = cookies.match(/better-auth\.session_token=([^;]+)/);
                    if (sessionCookieMatch) {
                        token = sessionCookieMatch[1];
                    }
                }

                if (!token) {
                    return res.status(401).send({ error: 'Unauthorized: Session token required.' });
                }

                const sessionDoc = await db.collection("session").findOne({ token });
                if (!sessionDoc) {
                    return res.status(401).send({ error: 'Unauthorized: Invalid session.' });
                }

                const userDoc = await db.collection("user").findOne({ _id: sessionDoc.userId });
                if (!userDoc || userDoc.isBlocked) {
                    return res.status(403).send({ error: 'Forbidden: Account is blocked.' });
                }
                if (userDoc.role !== 'client') {
                    return res.status(403).send({ error: 'Forbidden: Only clients can update proposal status.' });
                }

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ error: 'Invalid proposal ID format.' });
                }

                // Find the proposal
                const proposal = await proposalsCollection.findOne({ _id: new ObjectId(id) });
                if (!proposal) {
                    return res.status(404).send({ error: 'Proposal not found.' });
                }

                // Verify that the task belongs to this client
                if (!ObjectId.isValid(proposal.taskId)) {
                    return res.status(400).send({ error: 'Invalid task ID format in proposal.' });
                }
                const task = await tasksCollection.findOne({ _id: new ObjectId(proposal.taskId) });
                if (!task || task.clientId !== userDoc._id.toString()) {
                    return res.status(403).send({ error: 'Forbidden: You do not own the task associated with this proposal.' });
                }

                const result = await proposalsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status } }
                );

                res.send({ message: `Proposal status updated to ${status}.`, modifiedCount: result.modifiedCount });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });


        // ─── Admin Routes & Security Middleware ───────────────────

        const verifyAdmin = async (req, res, next) => {
            try {
                let token = req.headers.authorization?.split(' ')[1];
                if (!token) {
                    const cookies = req.headers.cookie || '';
                    const sessionCookieMatch = cookies.match(/better-auth\.session_token=([^;]+)/);
                    if (sessionCookieMatch) {
                        token = sessionCookieMatch[1];
                    }
                }

                if (!token) {
                    return res.status(401).send({ error: 'Unauthorized: Session token required.' });
                }

                const sessionDoc = await db.collection("session").findOne({ token });
                if (!sessionDoc) {
                    return res.status(401).send({ error: 'Unauthorized: Invalid session.' });
                }

                const userDoc = await db.collection("user").findOne({ _id: sessionDoc.userId });
                if (!userDoc || userDoc.isBlocked) {
                    return res.status(403).send({ error: 'Forbidden: Account is blocked or does not exist.' });
                }

                if (userDoc.role !== 'admin') {
                    return res.status(403).send({ error: 'Forbidden: Admin role required.' });
                }

                req.user = userDoc;
                next();
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        };

        // admin stats
        app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
            try {
                const totalUsers = await db.collection("user").countDocuments();
                const totalTasks = await tasksCollection.countDocuments();
                const activeTasks = await tasksCollection.countDocuments({ status: "open" });
                
                // calculate revenue from payments
                const payments = await paymentsCollection.find({ paymentStatus: "succeeded" }).toArray();
                const totalRevenue = payments.reduce((sum, p) => sum + (p.payoutSize || 0), 0);

                res.send({ totalUsers, totalTasks, activeTasks, totalRevenue });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // get all users
        app.get('/api/users', verifyAdmin, async (req, res) => {
            try {
                const users = await db.collection("user").find().toArray();
                res.send(users);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // verify or unverify a freelancer
        app.patch('/api/users/:id/verify', verifyAdmin, async (req, res) => {
            try {
                const { id } = req.params;
                const { isVerified } = req.body;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ error: 'Invalid user ID.' });
                }

                const result = await userCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { isVerified: Boolean(isVerified) } }
                );

                res.send({
                    message: `User ${isVerified ? 'verified' : 'unverified'} successfully.`,
                    modifiedCount: result.modifiedCount,
                });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // block or unblock a user
        app.patch('/api/users/:id/block', verifyAdmin, async (req, res) => {
            try {
                const { id } = req.params;
                const { isBlocked } = req.body;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ error: 'Invalid user ID.' });
                }

                const result = await db.collection("user").updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { isBlocked: Boolean(isBlocked) } }
                );

                res.send({ message: `User ${isBlocked ? 'blocked' : 'unblocked'} successfully.`, modifiedCount: result.modifiedCount });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // get all payments/transactions
        app.get('/api/admin/transactions', verifyAdmin, async (req, res) => {
            try {
                const payments = await paymentsCollection.find().sort({ paymentDate: -1 }).toArray();
                res.send(payments);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // get total spent for a specific client (by email)
        app.get('/api/client/spending/:email', async (req, res) => {
            try {
                const { email } = req.params;
                if (!email) return res.status(400).send({ error: 'Email required.' });
                const payments = await paymentsCollection.find({
                    clientEmail: email,
                    paymentStatus: 'succeeded'
                }).toArray();
                const totalSpent = payments.reduce((sum, p) => sum + (p.payoutSize || 0), 0);
                res.send({ totalSpent, count: payments.length });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });


        // ─── Client Ratings (freelancer → client) ─────────────────────────────

        // Submit a rating for a completed proposal
        app.post('/api/ratings', async (req, res) => {
            try {
                const userDoc = await resolveSessionUser(req);
                if (!userDoc) {
                    return res.status(401).send({ error: 'Unauthorized: Valid session required.' });
                }
                if (userDoc.role !== 'freelancer') {
                    return res.status(403).send({ error: 'Forbidden: Only freelancers can rate clients.' });
                }

                const { proposalId, taskId, clientId, stars, review } = req.body;
                const starNum = Number(stars);

                if (!proposalId || !taskId || !clientId) {
                    return res.status(400).send({ error: 'proposalId, taskId, and clientId are required.' });
                }
                if (!Number.isFinite(starNum) || starNum < 1 || starNum > 5) {
                    return res.status(400).send({ error: 'stars must be a number between 1 and 5.' });
                }
                if (!ObjectId.isValid(proposalId)) {
                    return res.status(400).send({ error: 'Invalid proposal ID.' });
                }

                const proposal = await proposalsCollection.findOne({ _id: new ObjectId(proposalId) });
                if (!proposal) {
                    return res.status(404).send({ error: 'Proposal not found.' });
                }
                if (proposal.freelancerEmail !== userDoc.email) {
                    return res.status(403).send({ error: 'Forbidden: You can only rate clients for your own proposals.' });
                }
                if (proposal.status?.toLowerCase() !== 'accepted') {
                    return res.status(400).send({ error: 'Only accepted proposals can be rated.' });
                }

                if (!ObjectId.isValid(taskId)) {
                    return res.status(400).send({ error: 'Invalid task ID.' });
                }
                const task = await tasksCollection.findOne({ _id: new ObjectId(taskId) });
                if (!task) {
                    return res.status(404).send({ error: 'Task not found.' });
                }
                if (task.clientId !== clientId.toString()) {
                    return res.status(400).send({ error: 'clientId does not match the task owner.' });
                }
                if (task.status?.toLowerCase() !== 'completed') {
                    return res.status(400).send({ error: 'Task must be completed before rating the client.' });
                }

                const existing = await ratingsCollection.findOne({ proposalId: proposalId.toString() });
                if (existing) {
                    return res.status(409).send({ error: 'You have already rated this client for this project.' });
                }

                const ratingDoc = {
                    proposalId: proposalId.toString(),
                    taskId: taskId.toString(),
                    clientId: clientId.toString(),
                    clientName: task.clientName || null,
                    clientEmail: task.clientEmail || null,
                    freelancerEmail: userDoc.email,
                    freelancerId: userDoc._id.toString(),
                    stars: starNum,
                    review: (review || '').trim(),
                    createdAt: new Date(),
                };

                const result = await ratingsCollection.insertOne(ratingDoc);
                const stats = await getClientRatingStats(clientId);

                res.status(201).send({
                    _id: result.insertedId,
                    ...ratingDoc,
                    clientStats: stats,
                });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // Get ratings — ?mine=true for logged-in freelancer, or /client/:clientId for averages
        app.get('/api/ratings', async (req, res) => {
            try {
                const { mine } = req.query;
                if (mine === 'true') {
                    const userDoc = await resolveSessionUser(req);
                    if (!userDoc) {
                        return res.status(401).send({ error: 'Unauthorized: Valid session required.' });
                    }
                    const ratings = await ratingsCollection
                        .find({ freelancerEmail: userDoc.email })
                        .sort({ createdAt: -1 })
                        .toArray();
                    return res.send(ratings);
                }

                const { clientId } = req.query;
                if (clientId) {
                    const stats = await getClientRatingStats(clientId);
                    return res.send(stats);
                }

                res.status(400).send({ error: 'Use ?mine=true or ?clientId=...' });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/ratings/client/:clientId', async (req, res) => {
            try {
                const stats = await getClientRatingStats(req.params.clientId);
                res.send(stats);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // ─── Freelancer Ratings (client → freelancer) ─────────────────────────

        // Submit a rating for a completed project's freelancer
        app.post('/api/freelancer-ratings', async (req, res) => {
            try {
                const userDoc = await resolveSessionUser(req);
                if (!userDoc) {
                    return res.status(401).send({ error: 'Unauthorized: Valid session required.' });
                }
                if (userDoc.role !== 'client') {
                    return res.status(403).send({ error: 'Forbidden: Only clients can rate freelancers.' });
                }

                const { taskId, freelancerEmail, stars, review } = req.body;
                const starNum = Number(stars);

                if (!taskId || !freelancerEmail) {
                    return res.status(400).send({ error: 'taskId and freelancerEmail are required.' });
                }
                if (!Number.isFinite(starNum) || starNum < 1 || starNum > 5) {
                    return res.status(400).send({ error: 'stars must be a number between 1 and 5.' });
                }

                if (!ObjectId.isValid(taskId)) {
                    return res.status(400).send({ error: 'Invalid task ID.' });
                }
                const task = await tasksCollection.findOne({ _id: new ObjectId(taskId) });
                if (!task) {
                    return res.status(404).send({ error: 'Task not found.' });
                }
                if (task.clientId !== userDoc._id.toString() && task.clientEmail !== userDoc.email) {
                    return res.status(403).send({ error: 'Forbidden: You can only rate freelancers for your own tasks.' });
                }
                if (task.status?.toLowerCase() !== 'completed') {
                    return res.status(400).send({ error: 'Task must be completed before rating the freelancer.' });
                }

                // Verify this freelancer actually worked on the task
                const proposal = await proposalsCollection.findOne({
                    taskId: taskId.toString(),
                    freelancerEmail: freelancerEmail,
                    status: { $regex: /^accepted$/i }
                });
                if (!proposal) {
                    return res.status(400).send({ error: 'This freelancer was not hired for this task.' });
                }

                const existing = await freelancerRatingsCollection.findOne({ 
                    taskId: taskId.toString(), 
                    freelancerEmail: freelancerEmail.toLowerCase() 
                });
                if (existing) {
                    return res.status(409).send({ error: 'You have already rated this freelancer for this task.' });
                }

                const ratingDoc = {
                    taskId: taskId.toString(),
                    taskTitle: task.title,
                    clientEmail: userDoc.email,
                    clientId: userDoc._id.toString(),
                    clientName: userDoc.name || userDoc.displayName || 'Client',
                    freelancerEmail: freelancerEmail.toLowerCase(),
                    stars: starNum,
                    review: (review || '').trim(),
                    createdAt: new Date(),
                };

                const result = await freelancerRatingsCollection.insertOne(ratingDoc);
                const stats = await syncFreelancerRating(freelancerEmail);

                res.status(201).send({
                    _id: result.insertedId,
                    ...ratingDoc,
                    freelancerStats: stats,
                });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // Get freelancer ratings — ?mine=true for client-submitted, ?freelancerEmail=... for average
        app.get('/api/freelancer-ratings', async (req, res) => {
            try {
                const { mine, freelancerEmail } = req.query;

                if (mine === 'true') {
                    const userDoc = await resolveSessionUser(req);
                    if (!userDoc) {
                        return res.status(401).send({ error: 'Unauthorized: Valid session required.' });
                    }
                    const ratings = await freelancerRatingsCollection
                        .find({ clientEmail: userDoc.email })
                        .sort({ createdAt: -1 })
                        .toArray();
                    return res.send(ratings);
                }

                if (freelancerEmail) {
                    const stats = await getFreelancerRatingStats(freelancerEmail);
                    const reviews = await freelancerRatingsCollection
                        .find({ freelancerEmail: freelancerEmail.toLowerCase().trim() })
                        .sort({ createdAt: -1 })
                        .toArray();
                    return res.send({
                        ...stats,
                        reviews
                    });
                }

                const all = await freelancerRatingsCollection.find().toArray();
                res.send(all);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // ─── Stripe Payment Endpoints ─────────────────────────────

        // create checkout session
        app.post('/api/create-checkout-session', async (req, res) => {
            try {
                const { proposalId } = req.body;
                if (!proposalId) {
                    return res.status(400).send({ error: 'Proposal ID is required.' });
                }

                let token = req.headers.authorization?.split(' ')[1];
                if (!token) {
                    const cookies = req.headers.cookie || '';
                    const sessionCookieMatch = cookies.match(/better-auth\.session_token=([^;]+)/);
                    if (sessionCookieMatch) {
                        token = sessionCookieMatch[1];
                    }
                }

                if (!token) {
                    return res.status(401).send({ error: 'Unauthorized: Session token required.' });
                }

                const sessionDoc = await db.collection("session").findOne({ token });
                if (!sessionDoc) {
                    return res.status(401).send({ error: 'Unauthorized: Invalid session.' });
                }

                const userDoc = await db.collection("user").findOne({ _id: sessionDoc.userId });
                if (!userDoc || userDoc.isBlocked) {
                    return res.status(403).send({ error: 'Forbidden: Account is blocked or does not exist.' });
                }

                if (userDoc.role !== 'client') {
                    return res.status(403).send({ error: 'Forbidden: Only clients can make payments.' });
                }

                if (!ObjectId.isValid(proposalId)) {
                    return res.status(400).send({ error: 'Invalid proposal ID format.' });
                }

                const proposal = await proposalsCollection.findOne({ _id: new ObjectId(proposalId) });
                if (!proposal) {
                    return res.status(404).send({ error: 'Proposal not found.' });
                }

                // Verify task ownership
                const task = await tasksCollection.findOne({ _id: new ObjectId(proposal.taskId) });
                if (!task || task.clientId !== userDoc._id.toString()) {
                    return res.status(403).send({ error: 'Forbidden: You do not own this task.' });
                }

                const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';

                // Create stripe checkout session
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    customer_email: userDoc.email, // pre-fill email from session
                    line_items: [
                        {
                            price_data: {
                                currency: 'usd',
                                product_data: {
                                    name: `Task: ${task.title}`,
                                    description: `Payment to freelancer: ${proposal.freelancerEmail}`,
                                },
                                unit_amount: Math.round(proposal.proposedBudget * 100), // in cents
                            },
                            quantity: 1,
                        },
                    ],
                    mode: 'payment',
                    success_url: `${clientUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}&proposal_id=${proposalId}`,
                    cancel_url: `${clientUrl}/dashboard/client/proposals`,
                    metadata: {
                        proposalId: proposal._id.toString(),
                        taskId: proposal.taskId,
                        clientEmail: userDoc.email,
                        freelancerEmail: proposal.freelancerEmail,
                        payoutSize: proposal.proposedBudget.toString(),
                        taskTitle: task.title,
                    },
                });

                res.send({ url: session.url });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // confirm stripe session and save to db
        app.post('/api/confirm-session', async (req, res) => {
            try {
                const { sessionId, proposalId } = req.body;
                if (!sessionId || !proposalId) {
                    return res.status(400).send({ error: 'Session ID and Proposal ID are required.' });
                }

                let session;
                if (sessionId.startsWith('cs_test_dummy_')) {
                    const proposal = await proposalsCollection.findOne({ _id: new ObjectId(proposalId) });
                    if (!proposal) {
                        return res.status(404).send({ error: 'Proposal not found.' });
                    }
                    const task = await tasksCollection.findOne({ _id: new ObjectId(proposal.taskId) });
                    if (!task) {
                        return res.status(404).send({ error: 'Associated task not found.' });
                    }
                    let clientUser = null;
                    try {
                        clientUser = await db.collection("user").findOne({ _id: new ObjectId(task.clientId) });
                    } catch (_) {
                        clientUser = await db.collection("user").findOne({ _id: task.clientId });
                    }
                    const clientEmail = clientUser ? clientUser.email : 'client@example.com';
                    session = {
                        payment_status: 'paid',
                        metadata: {
                            proposalId,
                            taskId: proposal.taskId,
                            clientEmail,
                            freelancerEmail: proposal.freelancerEmail,
                            payoutSize: proposal.proposedBudget.toString(),
                            taskTitle: task.title,
                        }
                    };
                } else {
                    // Retrieve the session from stripe to confirm payment
                    session = await stripe.checkout.sessions.retrieve(sessionId);
                    if (!session) {
                        return res.status(404).send({ error: 'Checkout session not found on Stripe.' });
                    }

                    if (session.payment_status !== 'paid') {
                        return res.status(400).send({ error: 'Payment not completed.' });
                    }

                    if (session.metadata.proposalId !== proposalId) {
                        return res.status(400).send({ error: 'Session metadata proposal mismatch.' });
                    }
                }

                // Double check if payment is already processed to avoid duplicates
                const existingPayment = await paymentsCollection.findOne({ sessionId });
                if (existingPayment) {
                    // Already processed, fetch the paid details
                    const proposal = await proposalsCollection.findOne({ _id: new ObjectId(proposalId) });
                    const task = await tasksCollection.findOne({ _id: new ObjectId(proposal.taskId) });
                    return res.send({
                        message: 'Payment already processed.',
                        taskTitle: task ? task.title : 'Task',
                        workerName: proposal ? proposal.freelancerEmail : 'Freelancer',
                        priceSize: existingPayment.payoutSize
                    });
                }

                // Update proposal status to accepted
                await proposalsCollection.updateOne(
                    { _id: new ObjectId(proposalId) },
                    { $set: { status: 'accepted' } }
                );

                const proposal = await proposalsCollection.findOne({ _id: new ObjectId(proposalId) });

                // Update task status to in-progress
                if (proposal && proposal.taskId) {
                    await tasksCollection.updateOne(
                        { _id: new ObjectId(proposal.taskId) },
                        { $set: { status: 'in-progress' } }
                    );
                }

                // Find the freelancer name/details (or use freelancerEmail as fallback)
                let workerName = proposal ? proposal.freelancerEmail : 'Freelancer';
                if (proposal && proposal.freelancerEmail) {
                    const freelancerUser = await db.collection("user").findOne({ email: proposal.freelancerEmail });
                    if (freelancerUser && freelancerUser.name) {
                        workerName = freelancerUser.name;
                    }
                }

                const taskTitle = session.metadata.taskTitle || (proposal ? proposal.taskTitle : 'Task');
                const payoutSize = Number(session.metadata.payoutSize);

                // Insert into payments collection
                const paymentDoc = {
                    sessionId,
                    clientEmail: session.metadata.clientEmail,
                    freelancerEmail: session.metadata.freelancerEmail,
                    payoutSize,
                    paymentDate: new Date(),
                    paymentStatus: 'succeeded'
                };
                await paymentsCollection.insertOne(paymentDoc);

                res.send({
                    message: 'Payment confirmed successfully.',
                    taskTitle,
                    workerName,
                    priceSize: payoutSize
                });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });


        await client.db("admin").command({ ping: 1 });






        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);



app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})