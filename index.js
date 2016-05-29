/*
 * @copyright Copyright (c) Sematext Group, Inc. - All Rights Reserved
 *
 * @licence SPM for NodeJS is free-to-use, proprietary software.
 * THIS IS PROPRIETARY SOURCE CODE OF Sematext Group, Inc. (Sematext)
 * This source code may not be copied, reverse engineered, or altered for any purpose.
 * This source code is to be used exclusively by users and customers of Sematext.
 * Please see the full license (found in LICENSE in this distribution) for details on its license and the licenses of its dependencies.
 */
'user strict'
var MAX_LOGS = process.env.LOGSENE_BULK_SIZE || 1000
var MAX_STORED_REQUESTS = process.env.LOGSENE_MAX_STORED_REQUESTS || 10000
var request = require('request')
var os = require('os')
var events = require('events')
var ipAddress = require('ip').address()
var util = require('util')
var path = require('path')
var fs = require('fs')
var stringifySafe = require('json-stringify-safe')
/**
 * token - the LOGSENE Token
 * type - type of log (string)
 * url - optional alternative URL for Logsene receiver (e.g. for on premises version)
 */
function Logsene (token, type, url, storageDirectory) {
  if (!token) {
    throw new Error('Logsene token not specified')
  }
  this.setUrl(url || process.env.LOGSENE_URL || 'https://logsene-receiver.sematext.com/_bulk')
  this.token = token
  this.type = type || 'logs'
  this.hostname = os.hostname()
  this.bulkReq = ''
  this.logCount = 0
  this.sourceName = null
  this.storedRequestCount = 0
  if (process.mainModule && process.mainModule.filename) {
    this.sourceName = path.basename(process.mainModule.filename)
  }
  events.EventEmitter.call(this)
  var self = this
  var tid = setInterval(function () {
    if (self.logCount > 0) {
      self.send()
    }
  }, process.env.LOGSENE_LOG_INTERVAL || 10000)
  if (tid.unref)
    tid.unref()
  process.on('exit', function () {
    self.send()
  })
  if (process.env.LOGSENE_TMP_DIR || storageDirectory) {
    this.diskBuffer(true, process.env.LOGSENE_TMP_DIR || storageDirectory)
  }
}
util.inherits(Logsene, events.EventEmitter)

Logsene.prototype.setUrl = function (url) {
  this.url = url
  var Agent = null
  if (/^https/.test(url)) {
    Agent = require('https').Agent
  } else {
    Agent = require('http').Agent
  }
  this.httpAgent = new Agent({maxSockets: 10})
}

Logsene.prototype.diskBuffer = function (enabled, dir) {
  this.tmpDir = path.join ((dir || require('os').tmpdir()), this.token)
  var mkpath = require ('mkpath')
  mkpath(this.tmpDir, function (err) {
    if (err) {
      this.persistence = false
      console.log('Error: can not activate disk buffer for logsene-js: ' + err )
    } else {
      this.persistence = enabled
      this.checkTmpDir = true
      if (enabled === true) {
        this.tid = setInterval(function () {
          this.retransmit()
        }.bind(this), 20000)
      } else {
        clearInterval(this.tid)
      }
    }
  }.bind(this))
}

/**
 * Add log message to send buffer
 * @param level - log level e.g. 'info', 'warning', 'error'
 * @param message - text message
 * @param fields - Object with custom fields or overwrite of any other field e.g. e.g. "{@timestamp: new Date.toISOString()}"
 * @param callback (err, msg object)
 */
Logsene.prototype.log = function (level, message, fields, callback) {
  var type = fields ? fields._type : this.type
  if (fields && fields._type) {
    delete fields._type
  }
  var msg = {'@timestamp': new Date(), severity: level, host: this.hostname, ip: ipAddress, message: message, '@source': this.sourceName}
  for (var x in fields) {
    // rename fields for Elasticsearch 2.x
    msg[x.replace(/\./g, '_').replace(/^_+/, '')] = fields[x]
  }
  if (typeof msg['@timestamp'] === 'number') {
    msg['@timestamp'] = new Date(msg['@timestamp'])
  }
  this.bulkReq += JSON.stringify({'index': {'_index': this.token, '_type': type || this.type}}) + '\n'
  this.bulkReq += stringifySafe(msg) + '\n'
  this.logCount++
  if (this.logCount >= MAX_LOGS) {
    this.send()
  }
  if (callback) {
    callback(null, msg)
  }
}

/**
 * Sending log entry  to LOGSENE - this function is triggered every 100 log message or 30 seconds.
 * @callback {function} optional callback function
 */
Logsene.prototype.send = function (callback) {
  var self = this
  var body = this.bulkReq
  var count = this.logCount
  this.bulkReq = ''
  this.logCount = 0
  var options = {
    url: this.url,
    headers: {
      'User-Agent': 'logsene-js',
      'Content-Type': 'application/json'
    },
    body: body,
    agent: self.httpAgent,
    method: 'POST'
  }
  request.post(options,
    function (err, res) {
      if (err) {
        self.emit('error', {source: 'logsene', url: options.url, err: err, body: body})
        if (self.persistence) {
          options.agent = false
          self.store({options: options})
        }
      } else {
        self.emit('log', {source: 'logsene', url: options.url, request: body, count: count, response: res.body})
      }
      if (callback) {
        callback(err, res)
      }
    })
}

Logsene.prototype.getFileName = function () {
  return path.join(this.tmpDir, new Date().getTime() + '.bulk')
}

Logsene.prototype.store = function (data, cb) {
  this.storedRequestCount++
  this.checkTmpDir = true
  if (this.storedRequestCount > MAX_STORED_REQUESTS) {
    cb(new Error('limit of max. stored requests reached, failed req. will not be stored'))
    return
  }
  var fn = this.getFileName()
  fs.writeFile(fn, JSON.stringify(data), function (err) {
    if (err && cb) {
      cb(err)
    }
  })
}

function walk (currentDirPath, callback) {
  var fs = require('fs')
  var path = require('path')
  try {
    fs.readdirSync(currentDirPath).forEach(function (name, index, fileList) {
      var filePath = path.join(currentDirPath, name)
      var stat = fs.stat(filePath, function (err, stat) {
        if (err) {
          return
        }
        if (stat.isFile()) {
          callback(filePath, stat)
        } else if (stat.isDirectory()) {
          walk(filePath, callback)
        }
      })
    })
    this.checkTmpDir=false
  } catch (err) {
    // ignore, nothing to do
  }
}

Logsene.prototype.shipFile = function (name, cb) {
  var self = this
  fs.readFile(name, function (ioerr, data) {
    if (ioerr) {
      if (cb) {
        return cb(ioerr)
      } else {
        return
      }
    }
    var options = JSON.parse(data)
    options.url = self.url
    request.post(options, function (err, res) {
      if (cb) {
        cb(err, res)
      }
      if (err) {
        self.emit('error', {source: 'logsene', url: options.url, err: err, body: options.body})
      } else {
        self.emit('file shipped', {file: name})
        self.emit('rt', {source: 'logsene', file: name, url: options.url, request: options.body, response: res.body})
      }
      self.storedRequestCount--
    })
  })
}

Logsene.prototype.retransmit = function () {
  if (!this.checkTmpDir) {
    return
  }
  walk(this.tmpDir, function (path, stats) {
    if (/bulk$/i.test(path)) {
      try {
        // rename the file, so a seond instance can't ship it in parallel
        var newFileName = path + '.lock'
        fs.renameSync(path, newFileName)
        this.shipFile(newFileName, function (err, res) {
          // remove file in any case, if req fails again
          // a new file will be created
          try {
            fs.unlinkSync(newFileName)
          } catch (err) {
            // ignore if file is already deleted
          }
        })
      } catch (ex) {
        // ignore, other process might have renemed the file
      }
    }
  }.bind(this))
}

module.exports = Logsene
