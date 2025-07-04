function setLangAttr(lang) {
  document.documentElement.lang = lang;
  localStorage.setItem("lang", lang);
}

function applyTranslations(translations) {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.dataset.i18n;
    if (translations[key]) el.textContent = translations[key];
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    if (translations[key]) el.placeholder = translations[key];
  });
}

function loadLanguage(lang) {
  fetch(`lang/${lang}.json`)
    .then(res => res.json())
    .then(applyTranslations)
    .catch(() => console.warn("Lingua non trovata"));
}

document.addEventListener("DOMContentLoaded", () => {
  const currentLang = localStorage.getItem("lang") || "it";
  loadLanguage(currentLang);
  setLangAttr(currentLang);

  const selector = document.getElementById("language-picker");
  if (selector) {
    selector.value = currentLang;
    selector.addEventListener("change", e => {
      const lang = e.target.value;
      loadLanguage(lang);
      setLangAttr(lang);
    });
  }
});
