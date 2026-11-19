// howdbswork.com health check for MongoDB. Read-only.
// Run:  mongosh --quiet "mongodb://user@host/admin" health-mo.js > report.txt
// Then paste report.txt into https://howdbswork.com/health/
// Needs: clusterMonitor (or equivalent) to read serverStatus, replSetGetStatus and $indexStats.
function out() { print(Array.prototype.slice.call(arguments).map(function (x) { return String(x).replace(/[|\n]/g, ' '); }).join('|')); }
function safe(f) { try { f(); } catch (e) { out('error', e.message); } }
out('engine', 'mo');
var ss = db.adminCommand({ serverStatus: 1 });
out('version', ss.version);
out('uptime_s', ss.uptime);
out('conn', 'current', ss.connections.current); out('conn', 'available', ss.connections.available);
safe(function () {
  var c = ss.wiredTiger.cache;
  out('wt_cache', c['bytes currently in the cache'], c['maximum bytes configured'], c['tracked dirty bytes in the cache'], c['pages read into cache']);
});
safe(function () {
  var st = db.adminCommand({ replSetGetStatus: 1 });
  var prim = st.members.filter(function (m) { return m.stateStr === 'PRIMARY'; })[0];
  st.members.forEach(function (m) {
    var lag = prim && m.optimeDate ? Math.round((prim.optimeDate - m.optimeDate) / 1000) : -1;
    out('member', m.name, m.stateStr, lag);
  });
  var oplog = db.getSiblingDB('local').oplog.rs;
  var first = oplog.find().sort({ $natural: 1 }).limit(1).next(), last = oplog.find().sort({ $natural: -1 }).limit(1).next();
  function secs(t) { return typeof t.getHighBits === "function" ? t.getHighBits() : (t.t != null ? t.t : t.getTime()); }
  out("oplog_window_s", secs(last.ts) - secs(first.ts));
});
safe(function () {
  var ops = db.adminCommand({ currentOp: 1, active: true, secs_running: { $gte: 60 } }).inprog;
  ops.slice(0, 3).forEach(function (o) { out('long_op', o.opid, o.secs_running, o.op, o.ns || ''); });
});
var colls = [];
db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.forEach(function (d) {
  if (['admin', 'local', 'config'].indexOf(d.name) >= 0) return;
  var dbx = db.getSiblingDB(d.name);
  dbx.getCollectionInfos({ type: 'collection' }).forEach(function (ci) {
    safe(function () {
      var s = dbx.getCollection(ci.name).aggregate([{ $collStats: { storageStats: {} } }]).next().storageStats;
      colls.push([d.name + '.' + ci.name, s.storageSize + (s.totalIndexSize || 0), s.count]);
      dbx.getCollection(ci.name).aggregate([{ $indexStats: {} }]).forEach(function (ix) {
        if (ix.name !== '_id_' && ix.accesses.ops == 0) out('unused_index', d.name + '.' + ci.name + '.' + ix.name, d.name + '.' + ci.name, s.indexSizes ? (s.indexSizes[ix.name] || 0) : 0, 0);
      });
    });
  });
});
colls.sort(function (a, b) { return b[1] - a[1]; }).slice(0, 15).forEach(function (c) { out('table', c[0], c[1], c[2]); });
safe(function () {
  var o = db.adminCommand({ getCmdLineOpts: 1 }).parsed;
  (function walk(x, p) {
    Object.keys(x).forEach(function (k) {
      var v = x[k], path = p ? p + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path); else out('setting', path, v);
    });
  })(o, '');
});
