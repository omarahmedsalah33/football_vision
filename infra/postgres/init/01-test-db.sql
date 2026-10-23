-- Separate database for automated tests so test runs never touch dev data.
CREATE DATABASE footballanalyzer_test OWNER fa_dev;
