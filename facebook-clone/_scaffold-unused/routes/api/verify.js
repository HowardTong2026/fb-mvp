/**
 * API Route: Verify Email Token
 * GET /api/verify?token=...
 * 
 * Verifies the user's email token and marks them as verified
 */

// src/routes/api/verify.js
export const GET = async ({ params, env }) => {
  const { token } = params;
  
  if (!token) {
    return new Response(
      JSON.stringify({ error: "Missing verification token" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  
  try {
    // In a real application, you would look up the token in your database
    // For this demo, we'll validate the token format and simulate verification
    
    // Token format: uuid v4
    const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (!tokenPattern.test(token)) {
      return new Response(
        JSON.stringify({ error: "Invalid verification token" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    
    // Simulate looking up the user and marking them as verified
    // In production, use D1 KV, R2, or Durable Object to update user status
    
    // For this demo, we'll accept any valid-looking token
    // and mark the user as verified
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: "Email verified successfully!" 
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "Verification failed", details: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};