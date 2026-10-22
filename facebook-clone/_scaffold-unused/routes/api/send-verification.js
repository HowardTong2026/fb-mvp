/**
 * API Route: Send verification email via Resend
 * POST /api/send-verification
 * 
 * Expects: { email: "user@example.com" }
 * Sends verification email with Resend
 */

// src/routes/api/send-verification.js
export const POST = async ({ request, env }) => {
  const body = await request.json();
  const { email } = body;
  
  if (!email || !env.RESEND_API_KEY) {
    return new Response(
      JSON.stringify({ error: "Missing email or Resend API key" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  
  try {
    // Generate a verification token
    const verificationToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    
    // Store the token in KV or database (simplified for this example)
    // In production, use D1 KV, R2, or Durable Object
    
    // Send verification email via Resend
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "onboarding@your-domain.com",
        to: [email],
        subject: "Verify your account - Facebook Clone",
        html: `
          <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a73e8;">Welcome to Facebook Clone!</h2>
            <p>Click the button below to verify your email address:</p>
            <a href="${process.env.SITE_URL}/verify-email?token=${verificationToken}" 
               style="background-color: #1a73e8; color: white; padding: 12px 24px; 
                      text-decoration: none; border-radius: 6; font-weight: bold;">
              Verify Email Address
            </a>
            <p style="margin-top: 24px; font-size: 12px; color: #65676b;">
              If you didn't sign up for Facebook Clone, you can safely ignore this email.
            </p>
          </div>
        `,
      }),
    });
    
    if (!resendResponse.ok) {
      const errorData = await resendResponse.json();
      return new Response(
        JSON.stringify({ error: "Failed to send email", details: errorData }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    
    return new Response(
      JSON.stringify({ success: true, token: verificationToken }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "Internal server error", details: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};