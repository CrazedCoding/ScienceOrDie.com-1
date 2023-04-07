const opts = require('./config.json')
const fs = require('fs');
const express = require('express');
const application = express()
const cors = require('cors');
const ws = require('ws')
const ssl = opts["ssl"] && opts["ssl"].key && opts["ssl"].cert
const factory = ssl ? require('https') : require('http');
const echo_chambers = require('./echo-chambers-protocol.js');

opts.debug = true; //TODO: Delete later

opts["ssl"] = ssl ? {
  "key": fs.readFileSync(opts["ssl"].key),
  "cert": fs.readFileSync(opts["ssl"].cert),
} : opts["ssl"];

if (!opts["ssl"]) {
  console.warn("No ssl set. Please run `node configure.js`!")
}
const router = express.Router();

router.all('*', (req, res, next) => {
  if (opts.debug) console.log(req.socket.remoteAddress, new Date(), req.url);
  try {
    res.setHeader('Content-Type', 'text/html')
  } catch(e) {
    console.log(e);
  }
  next()
})
router.use('/sounds', express.static('www/sounds'))
router.use('/js', express.static('www/js'))
router.use('/img', express.static('www/img'))
router.use('/favicon.ico', express.static('www/favicon.ico'))

router.get('/', (req, res, next) => {
  try {
    res.send(fs.readFileSync("./www/index.html"))
    res.end()
  } catch (e) {
    console.log(e)
    next()
  }
});

application.use(cors({
  origin: '*'
}));

if(ssl) {
  application.all('*', ensureSecure);
  require('http').createServer(application).listen(80)
}

application.use(function(req, res, next) {
  req.getUrl = function() {
    return req.protocol + "://" + req.get('host') + req.originalUrl;
  }
  return next();
});

application.use('/', router);
//  Server creation starts here
const server = factory.createServer(opts.ssl, application);
server.listen(ssl ? 443 : 80, err => {
  if (err) {
    console.log('Well, this didn\'t work...');
    process.exit();
  }
  console.log('Server is listening....');
});

const wss_protocol = echo_chambers.create();

const wss = new ws.Server({
  server,
  path: "/websockets"
});

wss.on('connection', (webSocket, req) => {
  webSocket.remoteAddress = req.socket.remoteAddress;
  webSocket.hostname = req.socket.remoteAddress;
  wss_protocol(webSocket)
});

function ensureSecure(req, res, next){
  if(req.secure){
    // OK, continue
    return next();
  };
  // handle port numbers if you need non defaults
  // res.redirect('https://' + req.host + req.url); // express 3.x
  res.redirect('https://' + req.hostname + req.url); // express 4.x
}