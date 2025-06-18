// test-api-login.js
require('dotenv').config();
const { loginToApi } = require('./client-instance/lib/apiSync.js');
let process = require('process');
// Manually set credentials for this test
process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC = process.env.TEST_API_USERNAME;
process.env.API_PASSWORD_FOR_CLIENT_BOT_LOGIC = process.env.TEST_API_PASSWORD;

console.log(`Testing API login for user: ${process.env.API_USERNAME_FOR_CLIENT_BOT_LOGIC}...`);

loginToApi().then(token => {
    if (token) {
        console.log('SUCCESS: API Login successful. Token received.');
        console.log('Token (first 10 chars):', token.substring(0, 10) + '...');
    } else {
        console.error('FAILURE: API Login failed. No token returned.');
    }
}).catch(err => {
    console.error('CRITICAL FAILURE: Error during API login test:', err);
});