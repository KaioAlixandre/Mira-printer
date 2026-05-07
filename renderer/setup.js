const form = document.getElementById('form');
const apiEl = document.getElementById('api');
const phoneEl = document.getElementById('phone');
const passEl = document.getElementById('pass');
const formErr = document.getElementById('formErr');
const submitBtn = document.getElementById('submitBtn');

window.mira.getSessionInfo().then((h) => {
  if (h.apiHttpBase) apiEl.value = h.apiHttpBase;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formErr.textContent = '';
  submitBtn.disabled = true;
  try {
    await window.mira.login({
      apiHttpBase: apiEl.value.trim(),
      telefone: phoneEl.value.trim(),
      password: passEl.value,
    });
  } catch (err) {
    formErr.textContent = err?.message || String(err);
  } finally {
    submitBtn.disabled = false;
  }
});
