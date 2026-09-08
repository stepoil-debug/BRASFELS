'use strict';

(function installTransparentBrandingFix() {
  const STEP_LOGO = 'assets/step-one-logo.svg?v=20260908';
  const BRASFELS_LOGO = 'assets/brasfels-logo.svg?v=19';
  const DASHBOARD_IMPROVEMENTS_VERSION = '20260908-1';
  let scheduled = false;

  function loadDashboardImprovements() {
    if (!document.querySelector('#brasfelsDashboardImprovementsCss')) {
      const link = document.createElement('link');
      link.id = 'brasfelsDashboardImprovementsCss';
      link.rel = 'stylesheet';
      link.href = `dashboard-improvements.css?v=${DASHBOARD_IMPROVEMENTS_VERSION}`;
      document.head.appendChild(link);
    }
    if (!document.querySelector('#brasfelsDashboardImprovementsJs')) {
      const script = document.createElement('script');
      script.id = 'brasfelsDashboardImprovementsJs';
      script.src = `dashboard-improvements.js?v=${DASHBOARD_IMPROVEMENTS_VERSION}`;
      script.async = true;
      document.head.appendChild(script);
    }
  }

  function apply() {
    scheduled = false;

    document.querySelectorAll('.partner-logo-composition, .partner-card-logos').forEach(container => {
      container.classList.add('transparent-branding');

      const images = container.querySelectorAll('img');
      if (images[0]) {
        if (!images[0].src.includes('/assets/step-one-logo.svg')) images[0].src = STEP_LOGO;
        images[0].alt = 'STEP One';
        images[0].removeAttribute('referrerpolicy');
        images[0].dataset.transparentAsset = 'official-svg';
      }

      if (images[1]) {
        if (!images[1].src.includes('/assets/brasfels-logo.svg')) images[1].src = BRASFELS_LOGO;
        images[1].alt = 'BrasFELS';
        images[1].dataset.transparentAsset = 'official';
      }

      container.querySelectorAll('.partner-x, span').forEach(element => element.remove());
    });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(apply);
  }

  window.addEventListener('load', () => {
    loadDashboardImprovements();
    schedule();
    const observer = new MutationObserver(mutations => {
      if (mutations.some(mutation => mutation.addedNodes.length || mutation.removedNodes.length)) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
