var IF = require("../")
IF(__dirname).on("child", function (c) {
  console.error(c.path.substr(c.root.path.length + 1))
})
