const form = document.getElementById('reset-form');
const statusMessage = document.getElementById('reset-status');
const mobile = document.getElementById('mobile');
const password = document.getElementById('password');
const confirmation = document.getElementById('confirmation');
const submit = form.querySelector('button');
const code = location.hash.slice(1);

if (code) history.replaceState(null, '', location.pathname);

if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
  statusMessage.textContent = 'Open the complete reset link provided by the office.';
} else {
  form.hidden = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    if (password.value !== confirmation.value) {
      statusMessage.textContent = 'The passwords do not match.';
      confirmation.focus();
      return;
    }
    if (new TextEncoder().encode(password.value).length > 72) {
      statusMessage.textContent = 'Choose a password of at most 72 bytes.';
      password.focus();
      return;
    }
    submit.disabled = true;
    statusMessage.textContent = 'Saving password…';
    try {
      const response = await fetch('/api/mobile/auth/password-reset/confirm', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, mobile: mobile.value, newPassword: password.value }),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) {
        statusMessage.textContent = result.message || 'Could not reset your password. Try again.';
        return;
      }
      form.reset();
      form.hidden = true;
      statusMessage.textContent = 'Password updated. Open My Real Assets and sign in with your registered mobile number and new password.';
    } catch {
      statusMessage.textContent = 'Could not confirm the reset. If saving did not complete, reopen the reset link and try again.';
    } finally {
      submit.disabled = false;
    }
  });
}
