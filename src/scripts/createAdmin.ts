import connectDB from '../config/db.js';
import User from '../models/user.js';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const createAdmin = async () => {
    await connectDB();

    const username = process.env.ADMIN_USER || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'hacker123';
    const email = process.env.ADMIN_EMAIL || 'admin@polyhacker.tech';

    try {
        const existing = await User.findOne({ role: 'admin' });
        if (existing) {
            console.log('Admin already exists:', existing.username);
            process.exit(0);
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const admin = new User({
            username,
            email,
            password: hashedPassword,
            role: 'admin',
            step: 'ready',
            config: {
                enabled: true,
                strategy: 'PERCENTAGE',
                copySize: 0,
                traderAddress: 'ADMIN'
            }
        });

        await admin.save();
        console.log(`✅ Admin created successfully!`);
        console.log(`Username: ${username}`);
        console.log(`Password: ${password}`);
        process.exit(0);
    } catch (error) {
        console.error('Error creating admin:', error);
        process.exit(1);
    }
};

createAdmin();
