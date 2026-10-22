/**
 * API Route: Google OAuth Callback
 * GET /api/google-callback
 * 
 * Handles the Google OAuth response and creates/ logs in the user
 */

// src/routes/api/google-callback.js
export const GET = async ({ request, env }) => {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  
  if (!code) {
    return new Response(
      JSON.stringify({ error: "No authorization code received" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  
  try {
    // Exchange authorization code for tokens
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${process.env.SITE_URL}/api/google-callback`,
        grant_type: "authorization_code",
      }),
    });
    
    const tokens = await tokenResponse.json();
    
    if (!tokens.access_token) {
      return new Response(
        JSON.stringify({ error: "Failed to exchange token", details: tokens }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    
    // Get user info from Google
    const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    
    const userInfo = await userInfoResponse.json();
    
    // Check if user exists, create if not (simplified)
    // In production, use D1 or Durable Object
    const userId = `google_${userInfo.id}`;
    const email = userInfo.email;
    const name = userInfo.name;
    
    // Create verification token for the new user
    const verificationToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    
    // Mark user as pending verification
    // Store in a simple KV or database
    await env.MY_KV?.put(`user:${userId}`, JSON.stringify({
      id: userId,
      email,
      name,
      verified: false,
      verificationToken,
      createdAt: new Date().toISOString(),
    }));
    
    // Send verification email
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "onboarding@your-domain.com",
        to: [email],
        subject: "Welcome to Facebook Clone - Verify your email",
        html: `
          <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a73e8;">Welcome, ${name}!</h2>
            <p>Thank you for signing up with Google. Click the button below to verify your email address:</p>
            <a href="${process.env.SITE_URL}/verify-email?token=${verificationToken}" 
               style="background-color: #1a73e8; color: white; padding: 12px 24px; 
                      text-decoration: none; border-radius: 6; font-weight: bold;">
              Verify Email
            </a>
            <p style="margin-top: 24px; font-size: 12px; color: #65676b;">
              This link will expire in 24 hours.
            </p>
          </div>
        `,
      }),
    });
    
    // Redirect to login page with success message
    const redirectUrl = "/login?registered=true";
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        user: { id: userId, email, name },
        redirectUrl 
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    
  } catch (error) {
    console.error("Google OAuth error:", error);
    return new Response(
      JSON.stringify({ error: "Google OAuth failed", details: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};