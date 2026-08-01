(function () {
  document.getElementById('yr').textContent = new Date().getFullYear();

  function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function card(p) {
    var tags = (p.lanes || []).map(function (l) { return '<span class="blog-tag">' + esc(l) + '</span>'; }).join('');
    return '<a class="blog-card" href="/blog/posts/' + encodeURIComponent(p.slug) + '.html">' +
      '<div class="blog-card-date">' + esc(p.dateHuman) + '</div>' +
      '<h2 class="blog-card-h">' + esc(p.title) + '</h2>' +
      '<p class="blog-card-p">' + esc(p.excerpt) + '</p>' +
      '<div class="blog-card-tags">' + tags + '</div>' +
      '</a>';
  }

  fetch('/blog/posts.json', { headers: { Accept: 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error('no posts.json yet'); return r.json(); })
    .then(function (data) {
      var posts = (data && data.posts) || [];
      var el = document.getElementById('blogList');
      if (!posts.length) {
        el.innerHTML = '<p class="blog-empty">The first daily briefing publishes automatically at 05:00 UTC. Check back tomorrow — or ask us directly.</p>';
        return;
      }
      el.innerHTML = posts.map(card).join('');
    })
    .catch(function () {
      var el = document.getElementById('blogList');
      el.innerHTML = '<p class="blog-empty">The first daily briefing publishes automatically at 05:00 UTC. Check back tomorrow — or ask us directly.</p>';
    });
})();
