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




const { MongoClient, ServerApiVersion } = require('mongodb');
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