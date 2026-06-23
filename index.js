const express = require('express');
const app = express()
const port = process.env.PORT || 5000
const cors = require('cors')
require('dotenv').config()

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
                    return res.send(tasks);
                }

                // 2. If no tasks found by clientId, try to find a single task by its task _id
                if (ObjectId.isValid(id)) {
                    const task = await tasksCollection.findOne({
                        _id: new ObjectId(id),
                    });
                    if (task) {
                        return res.send(task);
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
                const result = await tasksCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updatedTask }
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
                const result = await tasksCollection.deleteOne({
                    _id: new ObjectId(id),
                });

                res.send(result);
            } catch (error) {
                res.status(400).send({ error: 'Invalid ID' });
            }
        });

        // get all the tasks
        app.get('/api/tasks', async (req, res) => {
            const result = await tasksCollection.find().toArray();
            res.send(result);
        });



        //  freelancers
        app.get('/api/freelancers', async (req, res) => {
            try {
                const freelancers = await freelancersCollection
                    .find()
                    .sort({
                        rating: -1,
                        completedJobs: -1
                    })
                    .toArray();

                res.send(freelancers);
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
                            if (userDoc) {
                                targetEmail = userDoc.email;
                            }
                        }
                    }
                }

                if (targetEmail === 'mine') {
                    return res.status(401).send({ error: 'Unauthorized: Could not identify the freelancer from session.' });
                }

                const filter = targetEmail ? { freelancerEmail: targetEmail } : {};
                const proposals = await proposalsCollection.find(filter).sort({ submittedAt: -1 }).toArray();
                res.send(proposals);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });











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