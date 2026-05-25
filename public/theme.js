(function () {
  var KEY  = 'llm-monitor-theme';
  var html = document.documentElement;
  var mq   = window.matchMedia('(prefers-color-scheme: light)');

  function apply(theme) {
    html.setAttribute('data-theme', theme);
    var btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = theme === 'light' ? '☽' : '☀';
  }

  function load() {
    return localStorage.getItem(KEY) || (mq.matches ? 'light' : 'dark');
  }

  window.toggleTheme = function () {
    var next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    apply(next);
  };

  mq.addEventListener('change', function (e) {
    if (!localStorage.getItem(KEY)) apply(e.matches ? 'light' : 'dark');
  });

  apply(load());
}());
