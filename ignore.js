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

  // XXX
  // Existing filters are not handled properly.
  // this results in files being missed if they're re-included
  // if (props.filter &&
  //     (!this.parent || props.filter !== this.parent.filter)) {
  //   this._filter = props.filter
  // }

  props.filter = this.filter = this.filter.bind(this)

  // ensure that .ignore files always show up at the top of the list
  // that way, they can be read before proceeding to handle other
  // entries in that same folder
  if (props.sort) {
    this._sort = props.sort === "alpha" ? alphasort : props.sort
  }
  props.sort = this.sort.bind(this)

  // XXX This needs to be detected much earlier, in the
  // addEntries method.
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
    console.error("end", e.path, e._aborted)
    // perhaps aborted.  do nothing.
    if (i === 0 || e._aborted) return
    var rules = this.readRules(buf, e)
    this.addIgnoreRules(rules, e)
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


IgnoreReader.prototype.addIgnoreRules = function (set, e) {
  // filter out anything obvious
  set = set.filter(function (s) {
    s = s.trim()
    return s && !s.match(/^#/)
  })

  // no rules to add!
  if (!set.length) return

  console.error("addIgnoreRules", e.path, set)

  // now get a minimatch object for each one of these.
  // Note that we need to allow dot files by default, and
  // not switch the meaning of their exclusion, so they're
  var mm = set.map(function (s) {
    var m = new Minimatch(s, { matchBase: true, dot: true, flipNegate: true })
    m.ignoreFile = e.basename
    return m
  })

  if (!this.ignoreRules) this.ignoreRules = []
  this.ignoreRules.push.apply(this.ignoreRules, mm)
}


IgnoreReader.prototype.filter = function (entry) {

  var d = entry.basename === ".cba" ? function () {
    var p = this.path.substr(this.root.path.length)
    var args = [p, entry.path.substr(this.path.length)].concat([].slice.call(arguments))
    console.error.apply(console, args)
  }.bind(this) : function () {}

  d("FILTER: apply ignores")
  this.applyIgnores(entry)
  // if (!entry.excluded && this._filter) {
  //   d("Has a _filter")
  //   entry.excluded = !this._filter.apply(entry, arguments)
  //   d("applied _filter, excluded=", entry.excluded)
  // }

  // if it's an ignore file, we may not be in a mood to
  // include it, but its rules still have an effect, even
  // if it's been excluded.
  if (entry.excluded &&
      -1 !== this.ignoreFiles.indexOf(entry.basename)) {
    this.pause()
    this.disown(entry)

    this.emit("ignoreFile", entry)
    if (!entry._aborted)
      this.addIgnoreFile(entry)

    entry.on("close", function () {
      console.error("resuming", this.path, this.ignoreRules.map(function (m) {
        return (m.negate ? "!" : "") + m.pattern
      }))
      this.resume()
    }.bind(this))
    entry.on("data", function (c) {
      console.error("disowned data >" + c)
    })

    console.error("resuming entry")
    entry.resume()
  }

  return !entry.excluded
}


// sets an "excluded" flag on the entry if it's excluded.
IgnoreReader.prototype.applyIgnores = function (entry) {

  var d = entry.basename === ".cba" ? function () {
    var p = this.path.substr(this.root.path.length)
    var args = [p, entry.path.substr(this.path.length)].concat([].slice.call(arguments))
    console.error.apply(console, args)
  }.bind(this) : function () {}

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

  d("START")
  if (this.parent) this.parent.applyIgnores(entry)
  d("asked parents")
  if (!this.ignoreRules) {
    d("  no rules")
    return
  }

  var test = entry.path.substr(this.path.length)
  d("TEST", test, this.ignoreRules.map(function (rule) {
    return (rule.negate ? "!" : "") + rule.pattern
  }))


  // d("rules", this.ignoreRules.map(function (rule) {
  //   return (rule.negate ? "!" : "") + rule.pattern
  // }))

  // d("apply ignores "+ test)

  this.ignoreRules.forEach(function (rule) {
    // negation means inclusion
    if (rule.negate && !entry.excluded ||
        !rule.negate && entry.excluded) {
      d("  unnecessary", rule.pattern)
      return
    }

    // first, match against /foo/bar
    var match = rule.match(test)

    if (!match) {
      // try with the leading / trimmed off the test
      // eg: foo/bar instead of /foo/bar
      match = rule.match(test.substr(1))
    }

    d("  filematch", match, rule.pattern)

    // if the entry is a directory, then it will match
    // with a trailing slash. eg: /foo/bar/ or foo/bar/
    if (!match && entry.type === "Directory") {
      match = rule.match(test + "/")
      if (!match) {
        match = rule.match(test.substr(1) + "/")
      }

      // When including a file with a negated rule, it's
      // relevant if a directory partially matches, since
      // it may then match a file within it.
      // Eg, if you ignore /a, but !/a/b/c
      if (!match && rule.negate) {
        match = rule.match(test, true) ||
                rule.match(test.substr(1), true) ||
                rule.match(test + "/", true) ||
                rule.match(test.substr(1) + "/", true)
      }
      d("  dirmatch ", match, rule.pattern)
    }

    if (match) {
      entry.excluded = !rule.negate
      d("  MATCH! excluded =", entry.excluded, rule.pattern)
      //d("HIT", rule.negate, this.path, rule.pattern, entry.path.substr(this.path.length), this.ignoreRules.map(function (r) { return r.pattern }))
    }
  }, this)
  d("FINISH", entry.excluded)
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
