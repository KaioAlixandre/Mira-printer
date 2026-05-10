const form = document.getElementById('form');
const phoneEl = document.getElementById('phone');
const passEl = document.getElementById('pass');
const formErr = document.getElementById('formErr');
const submitBtn = document.getElementById('submitBtn');
const FIXED_API_HTTP_BASE = 'http://216.22.5.245:3002';

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formErr.textContent = '';
  submitBtn.disabled = true;
  try {
    await window.mira.login({
      apiHttpBase: FIXED_API_HTTP_BASE,
      telefone: phoneEl.value.trim(),
      password: passEl.value,
    });
  } catch (err) {
    formErr.textContent = err?.message || String(err);
  } finally {
    submitBtn.disabled = false;
  }
});
