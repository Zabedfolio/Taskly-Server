const express = require('express');
const app = express()
const port = process.env.PORT || 5000
const cors = require('cors')
require('dotenv').config()
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true
}))
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Hello World!')
})

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

let dbReady = false;

async function run() {
    try {
        await client.connect();

        const db = client.db("taskly-db");
        const tasksCollection = db.collection("tasks");
        const proposalsCollection = db.collection("proposals");
        const paymentsCollection = db.collection("payments");
        const userCollection = db.collection("user");
        const ratingsCollection = db.collection("ratings");
        const freelancerRatingsCollection = db.collection("freelancer_ratings");

        dbReady = true;

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

        async function syncFreelancerCompletedJobs(email, count) {
            if (!email) return;
            const normalized = email.toLowerCase();
            await userCollection.updateOne(
                { email: { $regex: new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
                { $set: { completedJobs: count } }
            );
        }

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

        app.get('/api/tasks/:id', async (req, res) => {
            const id = req.params.id;
            try {
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ error: 'Invalid task ID.' });
                }
                const result = await tasksCollection.findOne({ _id: new ObjectId(id) });
                if (!result) {
                    return res.status(404).send({ error: 'Task not found.' });
                }
                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

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

        app.delete('/api/tasks/:id', async (req, res) => {
            const id = req.params.id;
            try {
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ error: 'Invalid task ID format.' });
                }
                let token = req.headers.authorization?.split(' ')[1];
                if (!token) {
                    const cookies = req.headers.cookie || '';
                    const sessionCookieMatch = cookies.match(/better-auth\.session_token=([^;]+)/);
                    if (sessionCookieMatch) token = sessionCookieMatch[1];
                }
                if (!token) return res.status(401).send({ error: 'Unauthorized: Session token required.' });
                const sessionDoc = await db.collection("session").findOne({ token });
                if (!sessionDoc) return res.status(401).send({ error: 'Unauthorized: Invalid session.' });
                const userDoc = await db.collection("user").findOne({ _id: sessionDoc.userId });
                if (!userDoc || userDoc.isBlocked) return res.status(403).send({ error: 'Forbidden: Account is blocked.' });
                if (userDoc.role === 'admin') {
                    const result = await tasksCollection.deleteOne({ _id: new ObjectId(id) });
                    return res.send(result);
                }
                const task = await tasksCollection.findOne({ _id: new ObjectId(id) });
                if (!task) return res.status(404).send({ error: 'Task not found.' });
                if (task.clientId !== userDoc._id.toString()) return res.status(403).send({ error: 'Forbidden: You do not own this task.' });
                const acceptedProposal = await db.collection("proposals").findOne({ taskId: id, status: 'accepted' });
                if (acceptedProposal || task.status !== 'open') return res.status(400).send({ error: 'Forbidden: Cannot delete a task after a proposal has been accepted.' });
                const result = await tasksCollection.deleteOne({ _id: new ObjectId(id) });
                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/tasks', async (req, res) => {
            try {
                const result = await tasksCollection.find({}).sort({ createdAt: -1 }).toArray();
                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/freelancers', async (req, res) => {
            try {
                const freelancers = await userCollection
                    .find({ role: 'freelancer' })
                    .project({ password: 0 })
                    .toArray();
                res.send(freelancers);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/freelancers/:email', async (req, res) => {
            try {
                const email = req.params.email.toLowerCase().trim();
                const freelancer = await userCollection.findOne({ email, role: 'freelancer' });
                if (!freelancer) return res.status(404).send({ error: 'Freelancer not found.' });
                res.send(freelancer);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.post('/api/proposals', async (req, res) => {
            try {
                const proposal = req.body;
                proposal.submittedAt = new Date();
                const result = await proposalsCollection.insertOne(proposal);
                res.status(201).send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/proposals/:id', async (req, res) => {
            try {
                const { id } = req.params;
                if (!ObjectId.isValid(id)) return res.status(400).send({ error: 'Invalid proposal ID format.' });
                const proposal = await proposalsCollection.findOne({ _id: new ObjectId(id) });
                if (!proposal) return res.status(404).send({ error: 'Proposal not found.' });
                res.send(proposal);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/proposals', async (req, res) => {
            try {
                const { email, freelancerEmail } = req.query;
                const targetEmail = freelancerEmail || email;
                const filter = targetEmail ? { freelancerEmail: targetEmail } : {};
                const proposals = await proposalsCollection.find(filter).sort({ submittedAt: -1 }).toArray();
                res.send(proposals);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.patch('/api/proposals/:id/status', async (req, res) => {
            try {
                const { id } = req.params;
                const { status } = req.body;
                if (!['accepted', 'rejected', 'pending'].includes(status)) return res.status(400).send({ error: 'Invalid status value.' });
                if (!ObjectId.isValid(id)) return res.status(400).send({ error: 'Invalid proposal ID format.' });
                const result = await proposalsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status } }
                );
                res.send({ message: `Proposal status updated to ${status}.`, modifiedCount: result.modifiedCount });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        const verifyAdmin = async (req, res, next) => {
            try {
                let token = req.headers.authorization?.split(' ')[1];
                if (!token) {
                    const cookies = req.headers.cookie || '';
                    const sessionCookieMatch = cookies.match(/better-auth\.session_token=([^;]+)/);
                    if (sessionCookieMatch) token = sessionCookieMatch[1];
                }
                if (!token) return res.status(401).send({ error: 'Unauthorized: Session token required.' });
                const sessionDoc = await db.collection("session").findOne({ token });
                if (!sessionDoc) return res.status(401).send({ error: 'Unauthorized: Invalid session.' });
                const userDoc = await db.collection("user").findOne({ _id: sessionDoc.userId });
                if (!userDoc || userDoc.isBlocked) return res.status(403).send({ error: 'Forbidden: Account is blocked or does not exist.' });
                if (userDoc.role !== 'admin') return res.status(403).send({ error: 'Forbidden: Admin role required.' });
                req.user = userDoc;
                next();
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        };

        app.get('/api/users', verifyAdmin, async (req, res) => {
            try {
                const users = await db.collection("user").find().toArray();
                res.send(users);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.patch('/api/users/:id/verify', verifyAdmin, async (req, res) => {
            try {
                const { id } = req.params;
                const { isVerified } = req.body;
                if (!ObjectId.isValid(id)) return res.status(400).send({ error: 'Invalid user ID.' });
                const result = await userCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { isVerified: Boolean(isVerified) } }
                );
                res.send({ message: `User ${isVerified ? 'verified' : 'unverified'} successfully.`, modifiedCount: result.modifiedCount });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.patch('/api/users/:id/block', verifyAdmin, async (req, res) => {
            try {
                const { id } = req.params;
                const { isBlocked } = req.body;
                if (!ObjectId.isValid(id)) return res.status(400).send({ error: 'Invalid user ID.' });
                const result = await db.collection("user").updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { isBlocked: Boolean(isBlocked) } }
                );
                res.send({ message: `User ${isBlocked ? 'blocked' : 'unblocked'} successfully.`, modifiedCount: result.modifiedCount });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/payments', async (req, res) => {
            try {
                const payments = await paymentsCollection.find().toArray();
                res.send(payments);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/admin/transactions', verifyAdmin, async (req, res) => {
            try {
                const payments = await paymentsCollection.find().sort({ paymentDate: -1 }).toArray();
                res.send(payments);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.post('/api/ratings', async (req, res) => {
            try {
                const ratingDoc = req.body;
                ratingDoc.createdAt = new Date();
                const result = await ratingsCollection.insertOne(ratingDoc);
                res.status(201).send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/ratings', async (req, res) => {
            try {
                const { mine, clientId } = req.query;
                if (mine === 'true') {
                    const userDoc = await resolveSessionUser(req);
                    if (!userDoc) return res.status(401).send({ error: 'Unauthorized: Valid session required.' });
                    const ratings = await ratingsCollection
                        .find({ freelancerEmail: userDoc.email })
                        .sort({ createdAt: -1 })
                        .toArray();
                    return res.send(ratings);
                }
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

        app.post('/api/freelancer-ratings', async (req, res) => {
            try {
                const ratingDoc = req.body;
                ratingDoc.createdAt = new Date();
                const result = await freelancerRatingsCollection.insertOne(ratingDoc);
                res.status(201).send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/freelancer-ratings', async (req, res) => {
            try {
                const { clientEmail, freelancerEmail } = req.query;
                if (clientEmail) {
                    const ratings = await freelancerRatingsCollection
                        .find({ clientEmail: clientEmail.toLowerCase().trim() })
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
                    return res.send({ ...stats, reviews });
                }
                const all = await freelancerRatingsCollection.find().toArray();
                res.send(all);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.post('/api/create-checkout-session', async (req, res) => {
            try {
                const { proposalId } = req.body;
                if (!proposalId) return res.status(400).send({ error: 'Proposal ID is required.' });
                let token = req.headers.authorization?.split(' ')[1];
                if (!token) {
                    const cookies = req.headers.cookie || '';
                    const sessionCookieMatch = cookies.match(/better-auth\.session_token=([^;]+)/);
                    if (sessionCookieMatch) token = sessionCookieMatch[1];
                }
                if (!token) return res.status(401).send({ error: 'Unauthorized: Session token required.' });
                const sessionDoc = await db.collection("session").findOne({ token });
                if (!sessionDoc) return res.status(401).send({ error: 'Unauthorized: Invalid session.' });
                const userDoc = await db.collection("user").findOne({ _id: sessionDoc.userId });
                if (!userDoc || userDoc.isBlocked) return res.status(403).send({ error: 'Forbidden: Account is blocked or does not exist.' });
                if (userDoc.role !== 'client') return res.status(403).send({ error: 'Forbidden: Only clients can make payments.' });
                if (!ObjectId.isValid(proposalId)) return res.status(400).send({ error: 'Invalid proposal ID format.' });
                const proposal = await proposalsCollection.findOne({ _id: new ObjectId(proposalId) });
                if (!proposal) return res.status(404).send({ error: 'Proposal not found.' });
                const task = await tasksCollection.findOne({ _id: new ObjectId(proposal.taskId) });
                if (!task || task.clientId !== userDoc._id.toString()) return res.status(403).send({ error: 'Forbidden: You do not own this task.' });
                const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    customer_email: userDoc.email,
                    line_items: [{
                        price_data: {
                            currency: 'usd',
                            product_data: {
                                name: `Task: ${task.title}`,
                                description: `Payment to freelancer: ${proposal.freelancerEmail}`,
                            },
                            unit_amount: Math.round(proposal.proposedBudget * 100),
                        },
                        quantity: 1,
                    }],
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

        app.post('/api/confirm-session', async (req, res) => {
            try {
                const { sessionId, proposalId } = req.body;
                if (!sessionId || !proposalId) return res.status(400).send({ error: 'Session ID and Proposal ID are required.' });
                let session;
                if (sessionId.startsWith('cs_test_dummy_')) {
                    const proposal = await proposalsCollection.findOne({ _id: new ObjectId(proposalId) });
                    if (!proposal) return res.status(404).send({ error: 'Proposal not found.' });
                    const task = await tasksCollection.findOne({ _id: new ObjectId(proposal.taskId) });
                    if (!task) return res.status(404).send({ error: 'Associated task not found.' });
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
                    session = await stripe.checkout.sessions.retrieve(sessionId);
                    if (!session) return res.status(404).send({ error: 'Checkout session not found on Stripe.' });
                    if (session.payment_status !== 'paid') return res.status(400).send({ error: 'Payment not completed.' });
                    if (session.metadata.proposalId !== proposalId) return res.status(400).send({ error: 'Session metadata proposal mismatch.' });
                }
                const existingPayment = await paymentsCollection.findOne({ sessionId });
                if (existingPayment) {
                    const proposal = await proposalsCollection.findOne({ _id: new ObjectId(proposalId) });
                    const task = await tasksCollection.findOne({ _id: new ObjectId(proposal.taskId) });
                    return res.send({
                        message: 'Payment already processed.',
                        taskTitle: task ? task.title : 'Task',
                        workerName: proposal ? proposal.freelancerEmail : 'Freelancer',
                        priceSize: existingPayment.payoutSize
                    });
                }
                await proposalsCollection.updateOne(
                    { _id: new ObjectId(proposalId) },
                    { $set: { status: 'accepted' } }
                );
                const proposal = await proposalsCollection.findOne({ _id: new ObjectId(proposalId) });
                if (proposal && proposal.taskId) {
                    await tasksCollection.updateOne(
                        { _id: new ObjectId(proposal.taskId) },
                        { $set: { status: 'in-progress' } }
                    );
                }
                let workerName = proposal ? proposal.freelancerEmail : 'Freelancer';
                if (proposal && proposal.freelancerEmail) {
                    const freelancerUser = await db.collection("user").findOne({ email: proposal.freelancerEmail });
                    if (freelancerUser && freelancerUser.name) workerName = freelancerUser.name;
                }
                const taskTitle = session.metadata.taskTitle || (proposal ? proposal.taskTitle : 'Task');
                const payoutSize = Number(session.metadata.payoutSize);
                const paymentDoc = {
                    sessionId,
                    clientEmail: session.metadata.clientEmail,
                    freelancerEmail: session.metadata.freelancerEmail,
                    payoutSize,
                    paymentDate: new Date(),
                    paymentStatus: 'succeeded'
                };
                await paymentsCollection.insertOne(paymentDoc);
                res.send({ message: 'Payment confirmed successfully.', taskTitle, workerName, priceSize: payoutSize });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } catch (err) {
        console.error("Failed to connect to MongoDB:", err);
    }
}

run().catch(console.dir);

// For local development
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Example app listening on port ${port}`)
    });
}

module.exports = app;