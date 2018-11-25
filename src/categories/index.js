
'use strict';

var async = require('async');
var _ = require('lodash');

var db = require('../database');
var user = require('../user');
var Groups = require('../groups');
var plugins = require('../plugins');
var privileges = require('../privileges');

var Categories = module.exports;

require('./data')(Categories);
require('./create')(Categories);
require('./delete')(Categories);
require('./topics')(Categories);
require('./unread')(Categories);
require('./activeusers')(Categories);
require('./recentreplies')(Categories);
require('./update')(Categories);

Categories.exists = function (cid, callback) {
	db.exists('category:' + cid, callback);
};

Categories.getCategoryById = function (data, callback) {
	var category;
	async.waterfall([
		function (next) {
			Categories.getCategories([data.cid], data.uid, next);
		},
		function (categories, next) {
			if (!categories[0]) {
				return next(new Error('[[error:invalid-cid]]'));
			}
			category = categories[0];
			data.category = category;
			async.parallel({
				topics: function (next) {
					Categories.getCategoryTopics(data, next);
				},
				topicCount: function (next) {
					Categories.getTopicCount(data, next);
				},
				isIgnored: function (next) {
					Categories.isIgnored([data.cid], data.uid, next);
				},
				getParentsAndChildren: function (next) {
					Categories.getParentsAndChildren(categories, data.uid, next);
				},
			}, next);
		},
		function (results, next) {
			category.topics = results.topics.topics;
			category.nextStart = results.topics.nextStart;
			category.isIgnored = results.isIgnored[0];
			category.topic_count = results.topicCount;
			calculateTopicPostCount(category);
			plugins.fireHook('filter:category.get', { category: category, uid: data.uid }, next);
		},
		function (data, next) {
			next(null, data.category);
		},
	], callback);
};

Categories.isIgnored = function (cids, uid, callback) {
	if (parseInt(uid, 10) <= 0) {
		return setImmediate(callback, null, cids.map(() => false));
	}
	db.isSortedSetMembers('uid:' + uid + ':ignored:cids', cids, callback);
};

Categories.getAllCategories = function (uid, callback) {
	async.waterfall([
		function (next) {
			db.getSortedSetRange('categories:cid', 0, -1, next);
		},
		function (cids, next) {
			Categories.getCategories(cids, uid, next);
		},
	], callback);
};

Categories.getCidsByPrivilege = function (set, uid, privilege, callback) {
	async.waterfall([
		function (next) {
			db.getSortedSetRange(set, 0, -1, next);
		},
		function (cids, next) {
			privileges.categories.filterCids(privilege, cids, uid, next);
		},
	], callback);
};

Categories.getCategoriesByPrivilege = function (set, uid, privilege, callback) {
	async.waterfall([
		function (next) {
			Categories.getCidsByPrivilege(set, uid, privilege, next);
		},
		function (cids, next) {
			Categories.getCategories(cids, uid, next);
		},
	], callback);
};

Categories.getModerators = function (cid, callback) {
	async.waterfall([
		function (next) {
			Groups.getMembers('cid:' + cid + ':privileges:moderate', 0, -1, next);
		},
		function (uids, next) {
			user.getUsersFields(uids, ['uid', 'username', 'userslug', 'picture'], next);
		},
	], callback);
};

Categories.getCategories = function (cids, uid, callback) {
	if (!Array.isArray(cids)) {
		return callback(new Error('[[error:invalid-cid]]'));
	}

	if (!cids.length) {
		return callback(null, []);
	}
	uid = parseInt(uid, 10);
	async.waterfall([
		function (next) {
			async.parallel({
				categories: function (next) {
					Categories.getCategoriesData(cids, next);
				},
				tagWhitelist: function (next) {
					Categories.getTagWhitelist(cids, next);
				},
				hasRead: function (next) {
					Categories.hasReadCategories(cids, uid, next);
				},
			}, next);
		},
		function (results, next) {
			results.categories.forEach(function (category, i) {
				if (category) {
					category.tagWhitelist = results.tagWhitelist[i];
					category['unread-class'] = (category.topic_count === 0 || (results.hasRead[i] && uid !== 0)) ? '' : 'unread';
				}
			});
			next(null, results.categories);
		},
	], callback);
};

Categories.getTagWhitelist = function (cids, callback) {
	const keys = cids.map(cid => 'cid:' + cid + ':tag:whitelist');
	db.getSortedSetsMembers(keys, callback);
};

function calculateTopicPostCount(category) {
	if (!category) {
		return;
	}

	var postCount = category.post_count;
	var topicCount = category.topic_count;
	if (!Array.isArray(category.children) || !category.children.length) {
		category.totalPostCount = postCount;
		category.totalTopicCount = topicCount;
		return;
	}

	category.children.forEach(function (child) {
		calculateTopicPostCount(child);
		postCount += parseInt(child.totalPostCount, 10) || 0;
		topicCount += parseInt(child.totalTopicCount, 10) || 0;
	});

	category.totalPostCount = postCount;
	category.totalTopicCount = topicCount;
}

Categories.getParents = function (cids, callback) {
	var categoriesData;
	var parentCids;
	async.waterfall([
		function (next) {
			Categories.getCategoriesFields(cids, ['parentCid'], next);
		},
		function (_categoriesData, next) {
			categoriesData = _categoriesData;

			parentCids = categoriesData.filter(c => c && c.parentCid).map(c => c.parentCid);

			if (!parentCids.length) {
				return callback(null, cids.map(() => null));
			}

			Categories.getCategoriesData(parentCids, next);
		},
		function (parentData, next) {
			const cidToParent = _.zipObject(parentCids, parentData);
			parentData = categoriesData.map(category => cidToParent[category.parentCid]);
			next(null, parentData);
		},
	], callback);
};

Categories.getParentsAndChildren = function (categoryData, uid, callback) {
	const parentCids = categoryData.filter(c => c && c.parentCid).map(c => c.parentCid);
	async.waterfall([
		function (next) {
			async.parallel({
				parents: function (next) {
					Categories.getCategoriesData(parentCids, next);
				},
				children: function (next) {
					async.each(categoryData, function (category, next) {
						getChildrenTree(category, uid, next);
					}, next);
				},
			}, next);
		},
		function (results, next) {
			const cidToParent = _.zipObject(parentCids, results.parents);
			categoryData.forEach(function (category) {
				category.parent = cidToParent[category.parentCid];
			});
			next(null, categoryData);
		},
	], callback);
};

Categories.getChildren = function (cids, uid, callback) {
	var categories;
	async.waterfall([
		function (next) {
			Categories.getCategoriesFields(cids, ['parentCid'], next);
		},
		function (categoryData, next) {
			categories = categoryData.map((category, index) => ({ cid: cids[index], parentCid: category.parentCid }));
			async.each(categories, function (category, next) {
				getChildrenTree(category, uid, next);
			}, next);
		},
		function (next) {
			next(null, categories.map(c => c && c.children));
		},
	], callback);
};

function getChildrenTree(category, uid, callback) {
	let children;
	async.waterfall([
		function (next) {
			Categories.getChildrenCids(category.cid, next);
		},
		function (children, next) {
			privileges.categories.filterCids('find', children, uid, next);
		},
		function (children, next) {
			children = children.filter(cid => parseInt(category.cid, 10) !== parseInt(cid, 10));
			if (!children.length) {
				category.children = [];
				return callback();
			}
			Categories.getCategoriesData(children, next);
		},
		function (_children, next) {
			children = _children.filter(Boolean);

			const cids = children.map(child => child.cid);
			Categories.hasReadCategories(cids, uid, next);
		},
		function (hasRead, next) {
			hasRead.forEach(function (read, i) {
				const child = children[i];
				child['unread-class'] = (child.topic_count === 0 || (read && uid !== 0)) ? '' : 'unread';
			});
			Categories.getTree([category].concat(children), category.parentCid);
			next();
		},
	], callback);
}

Categories.getChildrenCids = function (rootCid, callback) {
	var allCids = [];
	function recursive(keys, callback) {
		db.getSortedSetRange(keys, 0, -1, function (err, childrenCids) {
			if (err) {
				return callback(err);
			}

			if (!childrenCids.length) {
				return callback();
			}
			const keys = childrenCids.map(cid => 'cid:' + cid + ':children');
			childrenCids.forEach(cid => allCids.push(parseInt(cid, 10)));
			recursive(keys, callback);
		});
	}

	recursive('cid:' + rootCid + ':children', function (err) {
		callback(err, _.uniq(allCids));
	});
};

Categories.flattenCategories = function (allCategories, categoryData) {
	categoryData.forEach(function (category) {
		if (category) {
			allCategories.push(category);

			if (Array.isArray(category.children) && category.children.length) {
				Categories.flattenCategories(allCategories, category.children);
			}
		}
	});
};

/**
 * Recursively build tree
 *
 * @param categories {array} flat list of categories
 * @param parentCid {number} start from 0 to build full tree
 */
Categories.getTree = function (categories, parentCid) {
	const cids = categories.map(category => category.cid);
	const cidToCategory = _.zipObject(cids, _.cloneDeep(categories));
	const tree = buildRecursive(categories, parentCid || 0);

	function buildRecursive(categories, parentCid) {
		var tree = [];

		categories.forEach(function (category) {
			if (category) {
				category.children = category.children || [];
				if (!category.cid) {
					return;
				}
				if (!category.hasOwnProperty('parentCid') || category.parentCid === null) {
					category.parentCid = 0;
				}

				if (category.parentCid === parentCid) {
					tree.push(category);
					category.parent = cidToCategory[parentCid];
					category.children = buildRecursive(categories, category.cid);
				}
			}
		});
		tree.sort((a, b) => a.order - b.order);
		return tree;
	}

	categories.forEach(c => calculateTopicPostCount(c));
	return tree;
};

Categories.buildForSelect = function (uid, privilege, callback) {
	async.waterfall([
		function (next) {
			Categories.getCategoriesByPrivilege('categories:cid', uid, privilege, next);
		},
		function (categories, next) {
			categories = Categories.getTree(categories);
			Categories.buildForSelectCategories(categories, next);
		},
	], callback);
};

Categories.buildForSelectCategories = function (categories, callback) {
	function recursive(category, categoriesData, level, depth) {
		var bullet = level ? '&bull; ' : '';
		category.value = category.cid;
		category.level = level;
		category.text = level + bullet + category.name;
		category.depth = depth;
		categoriesData.push(category);
		if (Array.isArray(category.children)) {
			category.children.forEach(function (child) {
				recursive(child, categoriesData, '&nbsp;&nbsp;&nbsp;&nbsp;' + level, depth + 1);
			});
		}
	}

	var categoriesData = [];

	categories = categories.filter(category => category && !category.parentCid);

	categories.forEach(function (category) {
		recursive(category, categoriesData, '', 0);
	});
	callback(null, categoriesData);
};

Categories.getIgnorers = function (cid, start, stop, callback) {
	db.getSortedSetRevRange('cid:' + cid + ':ignorers', start, stop, callback);
};

Categories.filterIgnoringUids = function (cid, uids, callback) {
	async.waterfall([
		function (next) {
			db.isSortedSetMembers('cid:' + cid + ':ignorers', uids, next);
		},
		function (isIgnoring, next) {
			const readingUids = uids.filter((uid, index) => uid && !isIgnoring[index]);
			next(null, readingUids);
		},
	], callback);
};

Categories.async = require('../promisify')(Categories);
