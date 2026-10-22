/**
 * Route: Email Verification
 * GET /verify-email?token=...
 * 
 * Verifies the user's email token and marks them as verified
 */

// src/routes/+page.js - The verification page
export const csr = true;

// This will be handled by the page component