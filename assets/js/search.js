(function () {
  var input = document.getElementById('siteSearch');
  if (!input) {
    return;
  }
  var box = document.getElementById('siteSearchResults');
  if (!box) {
    return;
  }

  var index = null;
  var loading = null;
  var NO_MATCH = 'Nothing on the site matches that yet. Try wal, vacuum, lag, or deadlock.';

  function depthPrefix() {
    var parts = window.location.pathname.split('/').filter(function (p) {
      return p.length > 0;
    });
    if (parts.length <= 1) {
      return '';
    }
    return '../';
  }

  function loadIndex() {
    if (index) {
      return Promise.resolve(index);
    }
    if (loading) {
      return loading;
    }
    loading = fetch('assets/search-index.json')
      .then(function (res) {
        if (!res.ok) {
          throw new Error('first path failed');
        }
        return res.json();
      })
      .catch(function () {
        return fetch('../assets/search-index.json').then(function (res) {
          if (!res.ok) {
            throw new Error('second path failed');
          }
          return res.json();
        });
      })
      .then(function (data) {
        index = Array.isArray(data) ? data : [];
        return index;
      })
      .catch(function () {
        index = [];
        return index;
      });
    return loading;
  }

  function hide() {
    box.innerHTML = '';
    box.style.display = 'none';
  }

  function show(query) {
    var q = query.trim().toLowerCase();
    if (!q) {
      hide();
      return;
    }
    loadIndex().then(function (items) {
      var scored = [];
      items.forEach(function (item) {
        var title = String(item.t || '').toLowerCase();
        var keys = String(item.k || '').toLowerCase();
        var score = 0;
        if (title.indexOf(q) !== -1) {
          score = 2;
        } else if (keys.indexOf(q) !== -1) {
          score = 1;
        }
        if (score > 0) {
          scored.push({ item: item, score: score });
        }
      });
      scored.sort(function (a, b) {
        return b.score - a.score;
      });
      var top = scored.slice(0, 8);
      box.innerHTML = '';
      if (top.length === 0) {
        var p = document.createElement('p');
        p.className = 'sitesearch-empty';
        p.textContent = NO_MATCH;
        box.appendChild(p);
        box.style.display = 'block';
        return;
      }
      var prefix = depthPrefix();
      top.forEach(function (entry) {
        var a = document.createElement('a');
        a.className = 'sitesearch-result';
        a.href = prefix + String(entry.item.u || '');
        var titleSpan = document.createElement('span');
        titleSpan.className = 'sitesearch-title';
        titleSpan.textContent = String(entry.item.t || '');
        var sectionSpan = document.createElement('span');
        sectionSpan.className = 'sitesearch-section';
        sectionSpan.textContent = String(entry.item.s || '');
        a.appendChild(titleSpan);
        a.appendChild(sectionSpan);
        box.appendChild(a);
      });
      box.style.display = 'block';
    });
  }

  function openFirst() {
    var first = box.querySelector('a.sitesearch-result');
    if (first) {
      window.location.href = first.getAttribute('href');
    }
  }

  input.addEventListener('focus', function () {
    loadIndex();
    if (input.value) {
      show(input.value);
    }
  });
  input.addEventListener('input', function () {
    show(input.value);
  });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      hide();
      input.blur();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openFirst();
    }
  });
  document.addEventListener('click', function (event) {
    if (!box.contains(event.target) && event.target !== input) {
      hide();
    }
  });
})();
