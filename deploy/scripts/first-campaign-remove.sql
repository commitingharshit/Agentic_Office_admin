-- Removes the test promotion and everything recorded about it.
DELETE FROM campaigns WHERE id = 'c_first_test';
SELECT 'removed' AS result;
