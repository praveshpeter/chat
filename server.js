// Local development server — sirf testing ke liye
// Vercel pe deploy hone pe yeh file use nahi hoti

const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Import matching logic
const matchHandler = require('./api/match');

// Route API calls to serverless function
app.post('/api/match', (req, res) => matchHandler(req, res));

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ NearChat running at http://localhost:${PORT}`);
  console.log(`   Open 2 tabs to test matching!`);
});
