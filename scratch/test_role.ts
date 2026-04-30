import axios from 'axios';

async function testSignup() {
    const baseUrl = 'http://localhost:3000'; // I'll assume it's running or I'll run it
    const testUser = {
        username: 'test_follower_' + Date.now(),
        email: 'follower' + Date.now() + '@test.com',
        password: 'password123'
    };

    console.log('--- Testing Signup ---');
    try {
        const res = await axios.post(`${baseUrl}/api/auth/signup`, testUser);
        console.log('Signup Response:', res.data);
        const cookie = res.headers['set-cookie'];
        console.log('Cookie:', cookie);

        const statusRes = await axios.get(`${baseUrl}/api/status`, {
            headers: { 'Cookie': cookie[0] }
        });
        console.log('Status Response (Role):', statusRes.data.role);
    } catch (e: any) {
        console.error('Test failed:', e.response?.data || e.message);
    }
}

testSignup();
