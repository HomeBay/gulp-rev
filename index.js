'use strict';
const path = require('path');
const through = require('through2');
const vinylFile = require('vinyl-file');
//const revHash = require('rev-hash');
//const revPath = require('rev-path');
const sortKeys = require('sort-keys');
const modifyFilename = require('modify-filename');
const Vinyl = require('vinyl');
const PluginError = require('plugin-error');

const crypto = require('crypto');

// Stolen from the `rev-hash` package. 
// Modified to generate a 32 character hash (instead of 10).
function revHash(input) {
	if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
		throw new TypeError('Expected a Buffer or string');
	}
	return crypto.createHash('md5').update(input).digest('hex').slice(0, 32);
}

// Stolen from the `rev-path` package.
// Modified to prefix the hash to a filename (versus appending it).
function revPath(pth, hash) {
	if (!(pth && hash)) {
		throw new Error('`path` and `hash` required');
	}
	return modifyFilename(pth, function (filename, ext) { 
		return `${hash}-${filename}${ext}`; 
	});
};


function relPath(base, filePath) {
	filePath = filePath.replace(/\\/g, '/');
	base = base.replace(/\\/g, '/');

	if (!filePath.startsWith(base)) {
		return filePath;
	}

	const newPath = filePath.slice(base.length);

	if (newPath[0] === '/') {
		return newPath.slice(1);
	}

	return newPath;
}

function transformFilename(file) {
	// Save the old path for later
	file.revOrigPath = file.path;
	file.revOrigBase = file.base;
	file.revHash = revHash(file.contents);

	file.path = modifyFilename(file.path, (filename, extension) => {
		const extIndex = filename.lastIndexOf('.');

		filename = extIndex === -1 ?
			revPath(filename, file.revHash) :
			revPath(filename.slice(0, extIndex), file.revHash) + filename.slice(extIndex);

		return filename + extension;
	});
}

const getManifestFile = opts => vinylFile.read(opts.path, opts).catch(error => {
	if (error.code === 'ENOENT') {
		return new Vinyl(opts);
	}

	throw error;
});

const plugin = () => {
	const sourcemaps = [];
	const pathMap = {};

	return through.obj((file, enc, cb) => {
		if (file.isNull()) {
			cb(null, file);
			return;
		}

		if (file.isStream()) {
			cb(new PluginError('gulp-rev', 'Streaming not supported'));
			return;
		}

		// This is a sourcemap, hold until the end
		if (path.extname(file.path) === '.map') {
			sourcemaps.push(file);
			cb();
			return;
		}

		const oldPath = file.path;
		transformFilename(file);
		pathMap[oldPath] = file.revHash;

		cb(null, file);
	}, function (cb) {
		sourcemaps.forEach(file => {
			let reverseFilename;

			// Attempt to parse the sourcemap's JSON to get the reverse filename
			try {
				reverseFilename = JSON.parse(file.contents.toString()).file;
			} catch (_) {}

			if (!reverseFilename) {
				reverseFilename = path.relative(path.dirname(file.path), path.basename(file.path, '.map'));
			}

			if (pathMap[reverseFilename]) {
				// Save the old path for later
				file.revOrigPath = file.path;
				file.revOrigBase = file.base;

				const hash = pathMap[reverseFilename];
				file.path = revPath(file.path.replace(/\.map$/, ''), hash) + '.map';
			} else {
				transformFilename(file);
			}

			this.push(file);
		});

		cb();
	});
};

plugin.manifest = (pth, opts) => {
	if (typeof pth === 'string') {
		pth = {path: pth};
	}

	opts = Object.assign({
		path: 'rev-manifest.json',
		merge: false,
		transformer: JSON
	}, opts, pth);

	let manifest = {};

	return through.obj((file, enc, cb) => {
		// Ignore all non-rev'd files
		if (!file.path || !file.revOrigPath) {
			cb();
			return;
		}

		const revisionedFile = relPath(path.resolve(file.cwd, file.base), path.resolve(file.cwd, file.path));
		const originalFile = path.join(path.dirname(revisionedFile), path.basename(file.revOrigPath)).replace(/\\/g, '/');

		manifest[originalFile] = revisionedFile;

		cb();
	}, function (cb) {
		// No need to write a manifest file if there's nothing to manifest
		if (Object.keys(manifest).length === 0) {
			cb();
			return;
		}

		getManifestFile(opts).then(manifestFile => {
			if (opts.merge && !manifestFile.isNull()) {
				let oldManifest = {};

				try {
					oldManifest = opts.transformer.parse(manifestFile.contents.toString());
				} catch (_) {}

				manifest = Object.assign(oldManifest, manifest);
			}

			manifestFile.contents = Buffer.from(opts.transformer.stringify(sortKeys(manifest), null, '  '));
			this.push(manifestFile);
			cb();
		}).catch(cb);
	});
};

module.exports = plugin;
