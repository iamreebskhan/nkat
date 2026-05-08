// Default environment for unit tests. Integration tests load from .env.test.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.PGHOST = process.env.PGHOST ?? 'localhost';
process.env.PGPORT = process.env.PGPORT ?? '5432';
process.env.PGDATABASE = process.env.PGDATABASE ?? 'billing_rules_test';
process.env.PGUSER = process.env.PGUSER ?? 'app';
process.env.PGPASSWORD = process.env.PGPASSWORD ?? 'app_dev_only_change_in_prod';
