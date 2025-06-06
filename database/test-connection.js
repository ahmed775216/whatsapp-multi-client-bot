const db = require('./db');

async function testConnection() {
    try {
        const result = await db.query('SELECT current_database(), current_user, version()');
        console.log('Connected to database:', result.rows[0].current_database);
        console.log('As user:', result.rows[0].current_user);
        console.log('PostgreSQL version:', result.rows[0].version);
        
        // Test table creation
        const tables = await db.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            ORDER BY table_name
        `);
        console.log('\nTables created:');
        tables.rows.forEach(row => console.log(' -', row.table_name));
        
        process.exit(0);
    } catch (err) {
        console.error('Connection test failed:', err);
        process.exit(1);
    }
}

testConnection();