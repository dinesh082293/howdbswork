/* Where to run it: a small rule set for the picker, and the full-cost comparison. */
(function () {
  function val(n) { var e = document.querySelector('input[name="' + n + '"]:checked'); return e ? e.value : null; }
  var go = document.getElementById('hostGo'), out = document.getElementById('hostOut');
  if (go && out) go.addEventListener('click', function () {
    var team = val('team'), apps = val('apps'), limit = val('limit'), load = val('load');
    if (!team || !apps || !limit || !load) { out.innerHTML = '<p class="labnote">Answer all four questions first.</p>'; return; }
    var where, why, own, notes = [], link = '#options';
    if (limit === 'residency') {
      where = 'On-prem, in your own facilities';
      why = 'A residency or regulatory rule decides this before cost or convenience does.';
      own = 'Everything: hardware, OS, engine, backups, failover, monitoring.';
      if (team === 'none') notes.push('Without database specialists, budget for hiring one, or for a vendor support contract, before go-live.');
      link = '#onprem';
    } else if (limit === 'control') {
      if (apps === 'k8s' && team === 'team') { where = 'Kubernetes with a mature operator'; link = '#k8s'; why = 'You need control the managed services do not give, and your team already runs Kubernetes well.'; own = 'The cluster spec, storage, backups to a bucket, upgrades and all tuning.'; }
      else { where = 'Self-managed on VMs (EC2 or equivalent)'; link = '#vm'; why = 'You need OS access, extensions or versions that managed services do not offer, without buying hardware.'; own = 'OS, engine, backups and restore tests, replication and failover, monitoring.'; }
      if (team === 'none') notes.push('This choice needs someone who can run backups and failover. If no one can, revisit whether the control is truly required.');
    } else if (team === 'none' || team === 'some') {
      if (load === 'spiky') { where = 'Serverless managed (Aurora Serverless v2 or similar)'; link = '#serverless'; why = 'The provider runs it, and you pay little while it is idle.'; notes.push('If it pauses at zero, the first connection waits about 15 seconds. Set client timeouts and retries for that, or keep a minimum capacity above zero for user-facing traffic.'); }
      else { where = 'A managed database service (RDS, Cloud SQL, Azure Database)'; link = '#managed'; why = 'Patching, backups and failover are handled, so a small team can spend its time on schema and queries.'; }
      own = 'Schema, indexes, queries, parameter choices, pooling, restore tests, and the bill.';
      if (apps === 'dc') notes.push('Your applications run in your own data center. A cloud database adds network latency to every query unless the applications move too.');
    } else {
      if (apps === 'k8s') { where = 'Kubernetes with an operator for the many small and medium databases, managed for the largest critical one'; link = '#k8s'; why = 'Your team runs Kubernetes well, so databases on it fit your tooling. The single most critical database is often still simpler on a managed service.'; own = 'The cluster specs, storage, backups, upgrades and tuning.'; }
      else if (load === 'steady' && apps !== 'dc') { where = 'Compare managed against self-managed on VMs, with the full-cost calculator below'; link = '#cost'; why = 'With a team in place and a large, steady load, self-managed on VMs or reserved managed capacity can cost less. Only your numbers can settle it.'; own = 'Depends on the result. The table under "Who does what" shows each.'; }
      else if (apps === 'dc') { where = 'On-prem, next to the applications'; link = '#onprem'; why = 'The applications and the team are already there, and the database belongs close to the applications.'; own = 'Everything, which your team is staffed for.'; }
      else { where = 'A managed database service'; link = '#managed'; why = 'Even with a strong team, managed services free it for the work no provider does: schema, queries and design.'; own = 'Schema, indexes, queries, parameters, pooling, restore tests, the bill.'; }
    }
    if (load === 'steady') notes.push('For steady load, price reserved or committed capacity once the size is known.');
    var h = '<div class="verdict"><b class="dt">Suggested</b>' + where + '<br><span style="font-size:14.5px">' + why + '</span></div>';
    h += '<p class="labnote"><b>What stays yours:</b> ' + own + '</p>';
    if (notes.length) h += '<ul style="font-size:14.5px;margin:6px 0 0;padding-left:20px">' + notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>';
    h += '<p class="labnote" style="margin-top:8px"><a href="' + link + '">Read about this option →</a></p>';
    out.innerHTML = h;
  });

  var ids = ['tMgB', 'tMgH', 'tVmB', 'tVmH', 'tK8B', 'tK8H', 'tOpB', 'tOpH', 'tRate'];
  if (!document.getElementById('tcoOut')) return;
  function n(id) { var v = parseFloat(document.getElementById(id).value); return isFinite(v) && v >= 0 ? v : 0; }
  function money(v) { return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function calc() {
    var r = n('tRate');
    var opts = [['Managed', n('tMgB'), n('tMgH')], ['VMs', n('tVmB'), n('tVmH')], ['Kubernetes', n('tK8B'), n('tK8H')], ['On-prem', n('tOpB'), n('tOpH')]];
    var tot = opts.map(function (o) { return { name: o[0], bill: o[1], people: o[2] * r, total: o[1] + o[2] * r }; });
    var best = tot.reduce(function (a, b) { return b.total < a.total ? b : a; });
    document.getElementById('tcoOut').innerHTML = tot.map(function (t) {
      return '<div' + (t === best ? ' style="outline:2px solid var(--teal)"' : '') + '><b>' + money(t.total) + '</b>' + t.name + ' per month: ' + money(t.bill) + ' bill + ' + money(t.people) + ' people</div>';
    }).join('');
    var billBest = opts.reduce(function (a, b) { return b[1] < a[1] ? b : a; });
    document.getElementById('tcoNote').textContent = billBest[0] === best.name
      ? 'Lowest full cost: ' + best.name + '. It also has the lowest bill.'
      : 'Lowest bill: ' + billBest[0] + '. Lowest full cost once people are counted: ' + best.name + '.';
  }
  ids.forEach(function (i) { document.getElementById(i).addEventListener('input', calc); });
  calc();
})();
