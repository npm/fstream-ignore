// Essentially, this is a fstream.DirReader class, but with a
// bit of special logic to read the specified sort of ignore files,
// and a filter that prevents it from picking up anything excluded
// by those files.

var Minimatch = require("minimatch").Minimatch
, fstream = require("fstream")
, DirReader = fstream.DirReader
, inherits = require("inherits")
, path = require("path")

module.exports = IgnoreReader

inherits(IgnoreReader, DirReader)

function IgnoreReader (props) {
  if (!(this instanceof IgnoreReader)) {
    return new IgnoreReader(props)
  }

  // must be a Directory type
  if (typeof props === "string") {
    props = { path: props }
  }

  props.type = "Directory"
  props.Directory = true

  if (!props.ignoreFiles) props.ignoreFiles = [".ignore"]
  this.ignoreFiles = props.ignoreFiles

  this.ignoreRules = null

  // get the set of ancestors that have ignore rules.
  // we unshift so that they'll be in the right order
  // to be iterated over from 0->length later.
  this.ancestorIgnores = []
  for (var p = this.parent; p; p = p.parent) {
    if (p.ignoreRules) this.ancestorIgnores.unshift(p)
  }
  // then, push this one in, so that it's the highest precedence
  this.ancestorIgnores.push(this)

  if (props.filter) this._filter = props.filter
  props.filter = this.filter.bind(this)

  // ensure that .ignore files always show up at the top of the list
  // that way, they can be read before proceeding to handle other
  // entries in that same folder
  if (props.sort) {
    this._sort = props.sort === "alpha" ? alphasort : props.sort
  }
  props.sort = this.sort.bind(this)

  this.on("entry", function (e) {
    // if this is an ignore file, then process it for rules
    var isIg = this.ignoreFiles.indexOf(e.basename) !== -1
    if (!isIg) return

    this.emit("ignoreFile", e)

    // call e.abort() in the above event to prevent its inclusion
    if (!e._aborted)
      this.addIgnoreFile(e)
  })

  DirReader.call(this, props)
}


IgnoreReader.prototype.getChildProps = function (stat) {
  var props = DirReader.prototype.getChildProps.call(this, stat)
  props.ignoreFiles = this.ignoreFiles

  // Directories have to be read as IgnoreReaders
  // otherwise fstream.Reader will create a DirReader instead.
  if (stat.isDirectory()) {
    props.type = this.constructor
  }
  return props
}


IgnoreReader.prototype.addIgnoreFile = function (e) {
  // buffer the output.
  // these files won't be very big.
  var buf = new Buffer(e.size)
  , i = 0

  e.on("data", ondata)
  function ondata (c) {
    c.copy(buf, i)
    i += c.length
  }

  var onend = function onend () {
    // perhaps aborted.  do nothing.
    if (i === 0 || e._aborted) return
    var rules = this.readRules(buf, e)
    this.addIgnoreRules(rules)
  }.bind(this)
  e.on("end", onend)

  e.on("abort", function () {
    e.removeListener("data", ondata)
    e.removeListener("end", onend)
  })
}


IgnoreReader.prototype.readRules = function (buf, entry) {
  return buf.toString().split(/\r?\n/)
}


IgnoreReader.prototype.addIgnoreRules = function (set) {
  // filter out anything obvious
  set = set.filter(function (s) {
    s = s.trim()
    return s && !s.match(/^#/)
  })

  // no rules to add!
  if (!set.length) return

  // now get a minimatch object for each one of these.
  // Note that we need to allow dot files by default, and
  // not switch the meaning of their exclusion, so they're
  var mm = set.map(function (s) {
    return new Minimatch(s, { matchBase: true, dot: true, flipNegate: true })
  })

  if (!this.ignoreRules) this.ignoreRules = []
  this.ignoreRules.push.apply(this.ignoreRules, mm)
}


IgnoreReader.prototype.filter = function (entry) {
  this.applyIgnores(entry)
  if (entry.excluded) return false
  return this._filter ? this._filter.apply(entry, arguments) : true

}


// sets an "excluded" flag on the entry if it's excluded.
IgnoreReader.prototype.applyIgnores = function (entry) {
  // walk back up the family tree.
  // At each level, test the entry against all the rules
  // at that level, as if it was rooted there.
  // For example, when testing a/b/c, we'll test against a's rules
  // as /b/c and then against b's rules as /c.  This is because
  // a .ignore file at a/.ignore would igore the a/b/c file with
  // a rule of `/b/c`, but not with a rule of `/c`.
  //
  // Negated Rules
  // Since we're *ignoring* things here, negating means that a file
  // is re-included, if it would have been excluded by a previous
  // rule.  So, negated rules are only relevant if the file
  // has been excluded.
  //
  // Similarly, if a file has been excluded, then there's no point
  // trying it against rules that have already been applied
  //
  // We're using the "flipnegate" flag here, which tells minimatch
  // to set the "negate" for our information, but still report
  // whether the core pattern was a hit or a miss.

  if (this.parent) this.parent.applyIgnores(entry)
  if (!this.ignoreRules) return

  var test = entry.path.substr(this.path.length)
  // console.error("rules", this.ignoreRules.map(function (rule) {
  //   return (rule.negate ? "!" : "") + rule.pattern
  // }))

  this.ignoreRules.forEach(function (rule) {
    // negation means inclusion
    if (rule.negate && !entry.excluded ||
        !rule.negate && entry.excluded) return

    var match = rule.match(test) || rule.match(test.substr(1))
    if (match) {
      entry.excluded = !rule.negate
      // console.error(entry.path.substr(entry.root.path.length),
      //               rule.pattern, rule.negate, entry.excluded)
    }
  })
}


IgnoreReader.prototype.sort = function (a, b) {
  var aig = this.ignoreFiles.indexOf(a) !== -1
  , big = this.ignoreFiles.indexOf(b) !== -1
  if (aig && !big) return -1
  if (big && !aig) return 1
  return this._sort(a, b)
}

IgnoreReader.prototype._sort = function (a, b) {
  return 0
}

function alphasort (a, b) {
  return a === b ? 0
       : a.toLowerCase() > b.toLowerCase() ? 1
       : a.toLowerCase() < b.toLowerCase() ? -1
       : a > b ? 1
       : -1
}
