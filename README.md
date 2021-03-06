# ytdl-splitter-core
Node.js module to download YouTube videos as separate audio files, using the tracklist provided on the description of the video or CUE files.

## Usage

Extract audio files using the tracklist provided in the description for the video:

    var Splitter = require('ytdl-splitter-core');
    var splitter = new Splitter();

    splitter.on('end', function(info) {
        console.log(info.url, 'split files at:', info.outputPath);
    });

    splitter.split('https://www.youtube.com/watch?v=SOME_VIDEO_ID');


Extract audio files using a CUE file as the tracklist:

    var Splitter = require('ytdl-splitter-core');
    var splitter = new Splitter();

    splitter.on('end', function(info) {
        console.log(info.url, 'split files at:', info.outputPath);
    });

    splitter.addCUETracklistExtractor('/tmp/some_file.cue');
    splitter.split('https://www.youtube.com/watch?v=SOME_VIDEO_ID');


## Notes

As this package depends on 'avconv', check for its requirements also. Currently, they are: the 'avconv' executable in your PATH, ready to be executed.

