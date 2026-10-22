/**
 * API Route: Google OAuth Login
 * GET /api/google-login
 * 
 * Initiates the Google OAuth 2.0 flow
 */

// src/routes/api/google-login.js
export const GET = async ({ request, env }) => {
  const url = new URL(request.url);
  const redirectUrl = url.searchParams.get("redirect") || "/";
  
  // Google OAuth 2.0 setup
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = `${process.env.SITE_URL}/api/google-callback`;
  
  if (!clientId) {
    return new Response(
      JSON.stringify({ error: "Google Client ID not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  
  // Build OAuth consent screen URL
  const oauthParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "consent",
  });
  
  const oauthUrl = `https://accounts.google.com/o/v2/auth?${oauthParams.toString()}`;
  
  return new Response(
    JSON.stringify({ 
      success: true, 
      authUrl: oauthUrl,
      redirectUrl 
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};