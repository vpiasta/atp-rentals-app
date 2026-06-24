const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Test the connection
supabase
    .from('listings')
    .select('*')
    .limit(1)
    .then(({ data, error }) => {
        if (error) console.error('Supabase connection error:', error);
        else console.log('✅ Supabase connected:', data?.length, 'rows');
    });

module.exports = { supabase, supabaseAdmin };
