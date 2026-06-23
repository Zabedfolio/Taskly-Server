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