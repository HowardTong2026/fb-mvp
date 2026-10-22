<!-- src/routes/+page.svelte - Main application page -->
<div class="app-container">
  <slot />
  
  {{#if showSignup}}
  <div class="signup-page">
    <h1>Join Facebook Clone</h1>
    
    {{#if error}}
    <div style="background: #fee2e2; border: 1px solid #fc8181; color: #9f1239; padding: 1rem; border-radius: 8; margin-bottom: 1.5rem;">
      {{error}}
    </div>
    {{/if}}
    
    <form on:submit|preventDefault="handleSignup">
      <div class="input-group">
        <label>Email Address</label>
        <input type="email" bind:value={email} required />
      </div>
      
      <button type="submit" class="btn">Send Verification Email</button>
    </form>
    
    <p style="margin-top: 2rem; font-size: 13px; color: #8e8e93;">
      Already have an account? <a href="#" on:click={() => showSignup = false}>Login here</a>
    </p>
  </div>
  {{/if}}
  
  {{#if showLogin}}
  <div class="signup-page">
    <h1>Login to Facebook Clone</h1>
    
    {{#if error}}
    <div style="background: #fee2e2; border: 1px solid #fc8181; color: #9f1239; padding: 1rem; border-radius: 8; margin-bottom: 1.5rem;">
      {{error}}
    </div>
    {{/if}}
    
    <form on:submit|preventDefault="handleLogin">
      <div class="input-group">
        <label>Email Address</label>
        <input type="email" bind:value={loginEmail} required />
      </div>
      
      <button type="submit" class="btn">Login</button>
    </form>
    
    <div style="margin-top: 2rem;">
      <button class="google-btn">
        <img src="https://www.gstatic.com/images/branding/googlemobile/2x/googleg_standard_color_128dp.png" alt="Google" />
        Continue with Google
      </button>
    </div>
    
    {{#if registered}}
    <div style="margin-top: 1.5rem; padding: 1rem; background: #e8f5e9; border-radius: 8; color: #2e7d32;">
      Account created! Check your email to verify.
    </div>
    {{/if}}
  </div>
  {{/if}}
  
  {{#if isVerified}}
  <div class="protected">
    <h2>Welcome!</h2>
    <p>Your email has been verified. You're now logged in to Facebook Clone.</p>
    <p>This is your protected content area.</p>
    <button class="btn" on:click="logout">Logout</button>
  </div>
  {{/if}}
  
  {{#if verifying}}
  <div class="verification-page">
    <h2>{{verificationStatus}}</h2>
    <p>Please wait while we verify your email...</p>
  </div>
  {{/if}}
</div>

<script>
  // State management
  let showSignup = true;
  let showLogin = false;
  let registered = false;
  let verifying = false;
  let verificationStatus = "";
  
  // Email inputs
  let email = "";
  let loginEmail = "";
  
  // Check URL for verification token
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const action = params.get("action");
  
  // Handle signup submission
  async function handleSignup(e) {
    e.preventDefault();
    
    if (!email) {
      setError("Please enter your email");
      return;
    }
    
    verifying = true;
    verificationStatus = "Sending verification email...";
    
    try {
      const response = await fetch("/api/send-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      
      const data = await response.json();
      
      if (data.success) {
        verificationStatus = "Verification email sent! Check your inbox.";
        setTimeout(() => {
          showSignup = false;
          showLogin = true;
          verifying = false;
        }, 3000);
      } else {
        throw new Error(data.details || "Failed to send email");
      }
    } catch (err) {
      console.error("Signup error:", err);
      verificationStatus = "Failed to send email. Please try again.";
      setTimeout(() => { verifying = false; }, 3000);
    }
  }
  
  // Handle login submission
  async function handleLogin(e) {
    e.preventDefault();
    
    if (!loginEmail) {
      setError("Please enter your email");
      return;
    }
    
    // Check if user exists and is verified
    // In a real app, you'd check your database/KV
    const userData = await checkUserVerified(loginEmail);
    
    if (userData && userData.verified) {
      // Set session/callback
      window.location.href = "/";
    } else if (userData && !userData.verified && userData.verificationToken === crypto.subtle.digest("SHA-256", new TextEncoder().encode(loginEmail))) {
      // User exists but not verified - show verification page
      showLogin = false;
      showSignup = false;
      verifying = true;
      verificationStatus = "Checking verification...";
      
      // Actually, redirect to verification
      window.location.href = `/verify-email?token=${userData.verificationToken}`;
    } else {
      setError("Account not found. Please sign up first.");
    }
  }
  
  // Simple user check (mock - replace with real DB lookup)
  async function checkUserVerified(email) {
    // This would check your KV/D1 database
    // For demo, we'll just return null
    return null;
  }
  
  function setError(msg) {
    // In a real app, show toast/error
    console.error(msg);
    alert(msg);
  }
  
  // Initialize based on URL params
  if (token && action === "verify") {
    // Verify the token
    verifyEmail(token);
  }
  
  // Verify email endpoint
  async function verifyEmail(token) {
    verifying = true;
    
    try {
      const response = await fetch(`/api/verify?token=${token}`, {
        method: "GET"
      });
      
      const data = await response.json();
      
      if (data.success) {
        verificationStatus = "Email verified successfully!";
        isVerified = true;
        setTimeout(() => {
          window.location.href = "/";
        }, 2000);
      } else {
        verificationStatus = data.error || "Verification failed";
        setTimeout(() => { verifying = false; }, 3000);
      }
    } catch (err) {
      console.error("Verify error:", err);
      verificationStatus = "Verification failed. Please try again.";
      setTimeout(() => { verifying = false; }, 3000);
    }
  }
  
  // Google Login
  window.loginWithGoogle = function() {
    fetch("/api/google-login")
      .then(res => res.json())
      .then(data => {
        if (data.authUrl) {
          window.location.href = data.authUrl;
        }
      })
      .catch(err => {
        console.error("Google login error:", err);
      });
  };
  
  // Logout
  function logout() {
    // Clear session
    window.location.href = "/";
  }
</script>