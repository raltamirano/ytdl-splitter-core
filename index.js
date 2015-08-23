var util = require('util');
var events = require('events');
var fs = require('fs');
var avconv = require('avconv');
var path = require('path');
var chainOfResponsibility = require('chaining-tool');
var cueParser  = require('cue-parser');
var youtubedl = require('youtube-dl');
var os = require('os');


function YTDLSplitterCore() {
	var self = this;

	/**
	 * We give outer access to this Chain-of-responsibility in order to
	 * enable client code to add additional tracklist extractors.
	 */
	self.tracklistExtractors = new chainOfResponsibility();

	// Add built-in tracklist extractors.
	self.tracklistExtractors.add(function(context, next) {
		var EXTRACTOR_NAME = 'DEFAULT';
		var TIME_MODE_START = 's';
		var TIME_MODE_DURATION = 'd';
		var regex = /(.*?)((\d{1,2}:\d{1,2})(.{0,5}(\d{1,2}:\d{1,2}))?)(.*)/gi;

		self.emit('message', 'Extractor "' + EXTRACTOR_NAME + '" starting...');

		var match, title, time, timeMode, index = 0;
		while (match = regex.exec(context.videoContext.description)) {
			title = (match[1] + match[6]).trim().replace(/^[\-\s\:]*/, '');
			time = self.momentToSeconds(match[3].trim());

			if (index == 0)
				timeMode = (time == 0) ? TIME_MODE_START : TIME_MODE_DURATION;

			if (timeMode == TIME_MODE_START) {
				start = time
				end = null;
				if (index > 0)
					context.tracklist.tracks[index-1].end = start;
			} else {
				start = (index == 0) ? 0 : context.tracklist.tracks[index-1].end;
				end = (index == 0) ? time : context.tracklist.tracks[index-1].end + time;
			}

			context.tracklist.tracks.push({
				"title": title,
				"start": start,
				"end": end
	        });

			index++;
		}


		if (index > 0) {  // Tracks were found!
			// In TIME_MODE_START, complete the 'end' of the last song is the
			// duration for the video.
			if (timeMode == TIME_MODE_START)
				context.tracklist.tracks[context.tracklist.tracks.length-1].end = context.videoContext.durationInSecs;

			context.tracklist.extractor = EXTRACTOR_NAME;
			self.emit('message', 'Extractor "' + EXTRACTOR_NAME + '" found ' + context.tracklist.tracks.length + ' songs.');
			next(false); // Finish the analysis
		} else {
			self.emit('message', 'Extractor "' + EXTRACTOR_NAME + '" did not find any songs.');
			next(); // Try with next extractor
		}
	});

	self.emit('ready');
};

// We're an event emmitter, yep.
util.inherits(YTDLSplitterCore, events.EventEmitter);

/**
* Adds a CUE tracklist extractor given a CUE file. This extractor
* is terminal: no more extractors will be tried after this one.
*/
YTDLSplitterCore.prototype.addCUETracklistExtractor = function(cueFile) {
	var self = this;
	self.tracklistExtractors.add(function(context, next) {
		var EXTRACTOR_NAME = 'CUE-EXTRACTOR-' + path.basename(cueFile);
		self.emit('message', 'Extractor "' + EXTRACTOR_NAME + '" starting...');

		var cueSheet = cueParser.parse(cueFile);

		context.tracklist.artistName = cueSheet.performer;
		context.tracklist.albumName = cueSheet.title;

		var start = 0;
		for(var index = 0; index < cueSheet.files[0].tracks.length; index++) {
			start = ((parseInt(cueSheet.files[0].tracks[index].indexes[0].time.min) * 60) +
				parseInt(cueSheet.files[0].tracks[index].indexes[0].time.sec));

			context.tracklist.tracks.push({
				"title": cueSheet.files[0].tracks[index].title,
				"start": start,
				"end": 0
			});

			if (index > 0)
				context.tracklist.tracks[index-1].end = start;
		}
		context.tracklist.tracks[context.tracklist.tracks.length-1].end = context.videoContext.durationInSecs;

		if (context.tracklist.tracks.length > 0)
			self.emit('message', 'Extractor "' + EXTRACTOR_NAME + '" found ' + context.tracklist.tracks.length + ' songs.');
		else
			self.emit('message', 'Extractor "' + EXTRACTOR_NAME + '" did not find any songs.');

		// This is a 'terminal' extractor.
		next(false);
	});
};

/**
* Splits a video on YouTube to separate audio file, given its URL.
*/
YTDLSplitterCore.prototype.split = function(url, options) {
	if (!options) options = {};

	this.emit('start', { "url": url });
	var self = this;
	youtubedl.getInfo(url, [], function(err, info) {
		if (err) {
			self.emit('error', { "url": url, "error": err });
			return;
		}

		// Let's somehow extract a tracklist from the video information we got,
		// then extract each song as a separate audio file.
		var videoContext = {
			"description": info.description,
			"duration": info.duration,
			"durationInSecs": self.momentToSeconds(info.duration)
		};

		if (options.albumName)
			videoContext.albumName = options.albumName;
		if (options.artistName)
			videoContext.artistName = options.artistName;
		if (options.albumYear)
			videoContext.albumYear = options.albumYear;
	    if (options.tracklistData)
			videoContext.description = options.tracklistData;

		self.extractTracklist(videoContext, function(tracklist) {
			if (!tracklist || !tracklist.tracks || tracklist.tracks.length <= 0)
					throw 'No tracklist could be inferred/read!';

			if (videoContext.albumName != undefined)
				tracklist.albumName = videoContext.albumName;
			if (videoContext.artistName != undefined)
				tracklist.artistName = videoContext.artistName;
			if (videoContext.albumYear != undefined)
				tracklist.albumYear = videoContext.albumYear;

			var video = new youtubedl(url);
			var inputFileRoot = path.join(os.tmpdir(), info._filename);
			fs.mkdirSync(inputFileRoot);
			var inputFile = path.join(inputFileRoot, info._filename);

			video.pipe(fs.createWriteStream(inputFile));

			video.on('end', function() {
				self.splitFileByTracklist(inputFile, tracklist, function(returnCode, outputPath) {
					if (returnCode == 0)
						self.emit('end', { "url": url, "outputPath": outputPath });
					else
						self.emit('error', { "url": url, "error": returnCode });
				});
			});
		});
	});
};


YTDLSplitterCore.prototype.extractTracklist = function(videoContext, callback) {
	var tracklist = new Tracklist();
	var context = { "videoContext": videoContext, "tracklist": tracklist };

	this.tracklistExtractors.start(context, function(context) {
		if (callback)
			callback(context.tracklist);
	}, function(context) {
		if (callback)
			callback(context.tracklist);
	});
};

YTDLSplitterCore.prototype.splitFileByTracklist = function(file, tracklist, callback) {
	var self = this;
	self.emit('message', "Splitting file '" + file + "' using tracklist: \n" + JSON.stringify(tracklist, null, 2));

	if (path.extname(file).toLowerCase() != '.mp3') {
		this.convertToMP3(file, function(conversionReturnCode, outputFile) {
			fs.unlink(file);

			if (conversionReturnCode != 0)
				self.emit('error', { "url": url, "error": conversionReturnCode });
			else
				self.splitMP3FileByTracklist(outputFile, tracklist, callback);
		});
	} else {
		this.splitMP3FileByTracklist(file, tracklist, callback);
	}
};

YTDLSplitterCore.prototype.momentToSeconds = function(input) {
	var parts = input.split(':');
	return ((parseInt(parts[0]) * 60) + parseInt(parts[1]));
};

YTDLSplitterCore.prototype.convertToMP3 = function(file, callback) {
	var self = this;
	self.emit('message', 'Converting "', file, '" to MP3 format.');

	var params = [];
	var outputFile = file + '.mp3';
	params.push('-i');
	params.push(file.replace(/ /g, "\ "));
	params.push('-vn');
	params.push('-qscale');
	params.push('1');
	params.push(outputFile.replace(/ /g, "\ "));

	var stream = avconv(params);

	stream.on('message', function(data) {
		self.emit('message', 'MP3 conversion -> ' + data);
	});

	stream.once('exit', function(exitCode, signal, metadata) {
		if (callback)
			callback(exitCode, outputFile);
	});
};

YTDLSplitterCore.prototype.splitMP3FileByTracklist = function(file, tracklist, callback) {
	var self = this;

	var params = [];
	params.push('-i');
	params.push(file.replace(/ /g, "\ "));

	var outputPath = path.dirname(file);
	var prevStart = 0;
	var allTracksAreNumbered = tracklist.allTracksAreNumbered();
	for(var index=0; index < tracklist.tracks.length; index++) {
		filename = (allTracksAreNumbered ? "" :
			("00" + (index+1)).slice(-2) + '.') + tracklist.tracks[index].title.replace(/[^a-z0-9\.]/gi, '_') + '.mp3';

		params.push('-acodec');
		params.push('copy');

		params.push('-metadata');
		params.push('title=' + tracklist.tracks[index].title);
		params.push('-metadata');
		params.push('track=' + (index+1));
		params.push('-metadata');
		params.push('album=' + tracklist.albumName);
		params.push('-metadata');
		params.push('artist=' + tracklist.artistName);
		if (tracklist.albumYear != 0) {
			params.push('-metadata');
			params.push('date=' + tracklist.albumYear);
		}


		params.push('-ss');
		params.push(tracklist.tracks[index].start.toString());
		params.push('-t');
		params.push((tracklist.tracks[index].end - prevStart).toString());
		params.push(path.join(outputPath, filename));

		prevStart = tracklist.tracks[index].end;
	}
	var stream = avconv(params);

	stream.on('message', function(data) {
		self.emit('message', 'Split by tracklist -> ' + data);
	});

	stream.once('exit', function(exitCode, signal, metadata) {
		fs.unlink(file);

		if (callback)
			callback(exitCode, outputPath);
	});
};

var Tracklist = function() {
	this.albumName = '';
	this.albumYear = 0;
	this.artistName = '';
	this.extractor = '';
	this.tracks = [];
};

Tracklist.prototype.allTracksAreNumbered = function() {
	for(var index=0; index<this.tracks.length; index++)
		if (!(/^[0-9]/.test(this.tracks[index].title)))
			return false;
	return true;
};

// Exports
module.exports = YTDLSplitterCore;
