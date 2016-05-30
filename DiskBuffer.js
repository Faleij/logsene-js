'use strict'
var path = require('path')
var fs = require('fs')
var diskBufferObjectCache = {}
var os = require('os')
var mkpath = require ('mkpath')
var util = require('util')
var events = require('events')

function log (message) {
	if (process.env.DEBUG_LOGSENE_DISK_BUFFER) {
		console.log(new Date().toISOString() + ': ' + message)	
	}
}

function DiskBuffer (options) {
  this.options = options || {tmpDir: os.getTempFileDir(), maxStoredRequests: 1000}
  this.tmpDir = options.tmpDir
  this.maxStoredRequests = options.maxStoredRequests || 1000
  this.storedFiles = []
  this.iterator = -1
  this.tid = setInterval(function () {
    this.retransmitNext()
  }.bind(this), options.interval || 10000)
  mkpath(this.tmpDir, function (err) {
  	if (err) {
  		log('Error: can not activate disk buffer for logsene-js: ' + err )
  	}
  })
}
util.inherits(DiskBuffer, events.EventEmitter)


DiskBuffer.prototype.retransmitNext = function () {
  if (this.storedFiles.length === 0) {
  	return
  }

	var index = 0 // this.storedFiles.length-1
	if (index < 0) {
		return
	}
	log('# of files: ' + this.storedFiles.length + ' current file:' +  index)
  if (this.storedFiles.length > index) {
    try {
      var fileName = this.storedFiles[index]
      if (!fileName) {
      	log('filename not in list:' + fileName)
     	  return
      }
      log('retransmitNext: ' + fileName)
      try {
      	fs.statSync(fileName)
      } catch (fsStatErr) {
      	this.rmFile(fileName)
      	return
      }
      var lockedFileName = fileName + '.lock'
      fs.renameSync(fileName, lockedFileName)
      var buffer = fs.readFileSync(lockedFileName)
      this.emit ('retransmit-req', {fileName: lockedFileName, buffer: buffer})
    } catch (err) {
      console.error('retransmitNext: ' + err.message)
    }
  }
}

DiskBuffer.prototype.syncFileListFromDir = function () {
	try {
		this.storedFiles = fs.readdirSync(this.tmpDir)
		this.storedFiles = this.storedFiles.filter(function (fileName) {
			var rv = false
			if (/\.bulk$/.test(fileName)) {
				rv = true
			} else {
				try {
					var fName = path.join(this.tmpDir, fileName)
					var fStat = fs.statSync(fName)
					var now = Date.now()
					if (now - fStat.atime.getTime() > 1000 * 60 * 5) {
						log('removing 5 min old .lock file')
						fs.unlinkSync(fName)
					}
				} catch (fsErr) {
					log('syncFileListFromDir error: ' + fsErr.message)
				}
			}
			return rv
		}.bind(this))
		this.storedFiles = this.storedFiles.map(function (fileName) {
			return path.join (this.tmpDir, fileName)
		}.bind(this))
	} catch (err) {
		this.storedFiles = []
	} 
	log('fileList: ' + this.storedFiles)
}

DiskBuffer.prototype.addFile = function (fileName) {
	var index = this.storedFiles.push(fileName)
	//this.storedFilesIndex[fileName] = {index: index, fileName: fileName, timestamp: Date.now()}
}

DiskBuffer.prototype.rmFile = function (fileName) {
	var index = this.storedFiles.indexOf(fileName.replace('.lock', ''))
	log('rm file:' + fileName)
	try {
		fs.unlinkSync(fileName)
		this.emit('removed', {fileName: fileName})
	} catch (err) {
		log('rmFile: could not delete file:' + err.message)
		// ignore when file was already deleted
	}
	if (index > -1) {
    this.storedFiles.splice(index, 1)
    return true
	} else {
		return false
	}
}

DiskBuffer.prototype.getFileName = function () {
  return path.join(this.tmpDir, this.storedFiles.length + '_' + new Date().getTime() + '.bulk')
}

DiskBuffer.prototype.store = function (data, cb) {
  this.storedRequestCount++
  this.checkTmpDir = true
  if (this.storedRequestCount > this.maxStoredRequests) {
    cb(new Error('DiskBuffer.store(): limit of max. stored requests reached, failed req. will not be stored'))
    return
  }
  var fn = this.getFileName()
  this.addFile(fn)
  fs.writeFile(fn, JSON.stringify(data), function (err) {
    if (cb & err) {
      return cb(err)
    }
  })
}

function createDiskBuffer (options) {
	if (!diskBufferObjectCache[options.tmpDir]) {
		diskBufferObjectCache[options.tmpDir] = new DiskBuffer (options)
	}
	return diskBufferObjectCache[options.tmpDir]
}
module.exports.createDiskBuffer = createDiskBuffer
module.exports.DiskBuffer = DiskBuffer

function test() {
	process.env.DEBUG_LOGSENE_DISK_BUFFER=true
	var db = createDiskBuffer({
		tmpDir: './tmp', 
		interval: 1000
	})
	var db2 = createDiskBuffer({
		tmpDir: './tmp'
	})
	db.syncFileListFromDir()
	db.on('retransmit-req', function (event) {
		setTimeout(function () {
			db.rmFile(event.fileName)
			db.retransmitNext()
		},500)
		
	})
	db.once('removed', function () {
		done
	})
	setInterval(function () {
		db.store('hello', log)	
	}, 1000)
}