<!-- src/routes/+layout.svelte -->
<div class="app-container">
  <slot />
  <footer style="margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #ddd; font-size: 12px; color: #65676b;">
    Powered by Cloudflare Workers + Resend
  </footer>
</div>

/* Global styles */
.app-container {
  min-height: 100vh;
  background: linear-gradient(135deg, #ffffff 0%, #f4f6f8 100%);
}

/* Signup/Login Page */
.signup-page {
  max-width: 500px;
  margin: 0 auto;
  padding: 2rem;
  border-radius: 12px;
  background: white;
  box-shadow: 0 4px 20px rgba(0,0,0,0.08);
}

.signup-page h1 {
  color: #1a73e8;
  font-size: 2.2rem;
  margin-bottom: 1.5rem;
  text-align: center;
}

.signup-page p {
  color: #5f6368;
  font-size: 1rem;
  text-align: center;
  margin-bottom: 2rem;
}

.input-group {
  margin-bottom: 1.5rem;
}

.input-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-size: 14px;
  color: #202124;
  font-weight: 500;
}

.input-group input {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 16px;
  box-sizing: border-box;
  transition: border-color 0.2s;
}

.input-group input:focus {
  outline: none;
  border-color: #1a73e8;
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.15);
}

.btn {
  width: 100%;
  padding: 12px 24px;
  background-color: #1a73e8;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
  margin-top: 1rem;
}

.btn:hover {
  background-color: #1557b0;
}

.btn:disabled {
  background-color: #90caf9;
  cursor: not-allowed;
}

/* Google Login Button */
.google-btn {
  width: 100%;
  padding: 12px 24px;
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 500;
  color: #202124;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 1rem;
  transition: border-color 0.2s;
}

.google-btn:hover {
  border-color: #8ab4e6;
}

.google-btn img {
  width: 20px;
  height: 20px;
}

/* Verification Page */
.verification-page {
  max-width: 500px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}

.verification-page.success {
  border: 2px solid #34a853;
}

.verification-page.error {
  border: 2px solid #ea4335;
}

.verification-page h2 {
  margin-bottom: 1rem;
}

.verification-page p {
  color: #5f6368;
  margin-bottom: 2rem;
}

/* Protected Content */
.protected {
  max-width: 800px;
  margin: 2rem auto;
  padding: 2rem;
  background: white;
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.08);
}