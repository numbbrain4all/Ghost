// # Post Model
var _              = require('lodash'),
    uuid           = require('node-uuid'),
    when           = require('when'),
    errors         = require('../errors'),
    Showdown       = require('showdown'),
    ghostgfm       = require('../../shared/lib/showdown/extensions/ghostgfm'),
    converter      = new Showdown.converter({extensions: [ghostgfm]}),
    AppField       = require('./appField').AppField,
    User           = require('./user').User,
    Tag            = require('./tag').Tag,
    Tags           = require('./tag').Tags,
    ghostBookshelf = require('./base'),
    xmlrpc         = require('../xmlrpc'),

    Post,
    Posts;

Post = ghostBookshelf.Model.extend({

    tableName: 'posts',

    defaults: function () {
        return {
            uuid: uuid.v4(),
            status: 'draft'
        };
    },

    initialize: function () {
        var self = this;

        ghostBookshelf.Model.prototype.initialize.apply(this, arguments);

        this.on('saved', function (model, attributes, options) {
            if (model.get('status') === 'published') {
                xmlrpc.ping(model.attributes);
            }
            return self.updateTags(model, attributes, options);
        });
    },

    saving: function (newPage, attr, options) {
        /*jshint unused:false*/
        var self = this,
            tagsToCheck,
            i;

        options = options || {};
        // keep tags for 'saved' event and deduplicate upper/lowercase tags
        tagsToCheck = this.get('tags');
        this.myTags = [];

        _.each(tagsToCheck, function (item) {
            if (_.isObject(self.myTags)) {
                for (i = 0; i < self.myTags.length; i = i + 1) {
                    if (self.myTags[i].name.toLocaleLowerCase() === item.name.toLocaleLowerCase()) {
                        return;
                    }
                }
                self.myTags.push(item);
            }
        });

        ghostBookshelf.Model.prototype.saving.call(this, newPage, attr, options);

        this.set('html', converter.makeHtml(this.get('markdown')));

        // disabling sanitization until we can implement a better version
        //this.set('title', this.sanitize('title').trim());
        this.set('title', this.get('title').trim());

        if ((this.hasChanged('status') || !this.get('published_at')) && this.get('status') === 'published') {
            if (!this.get('published_at')) {
                this.set('published_at', new Date());
            }
            // This will need to go elsewhere in the API layer.
            this.set('published_by', options.user);
        }

        if (this.hasChanged('slug') || !this.get('slug')) {
            // Pass the new slug through the generator to strip illegal characters, detect duplicates
            return ghostBookshelf.Model.generateSlug(Post, this.get('slug') || this.get('title'),
                    {status: 'all', transacting: options.transacting})
                .then(function (slug) {
                    self.set({slug: slug});
                });
        }

    },

    creating: function (newPage, attr, options) {
        /*jshint unused:false*/
        options = options || {};

        // set any dynamic default properties
        if (!this.get('author_id')) {
            this.set('author_id', options.user);
        }

        ghostBookshelf.Model.prototype.creating.call(this, newPage, attr, options);
    },

   /**
     * ### updateTags
     * Update tags that are attached to a post.  Create any tags that don't already exist.
     * @param {Object} newPost
     * @param {Object} attr 
     * @param {Object} options
     * @return {Promise(ghostBookshelf.Models.Post)} Updated Post model
     */
    updateTags: function (newPost, attr, options) {
        var self = this;
        options = options || {};

        if (!this.myTags) {
            return;
        }

        return Post.forge({id: newPost.id}).fetch({withRelated: ['tags'], transacting: options.transacting}).then(function (post) {
            var tagOps = [];

            // remove all existing tags from the post
            // _.omit(options, 'query') is a fix for using bookshelf 0.6.8
            // (https://github.com/tgriesser/bookshelf/issues/294)
            tagOps.push(post.tags().detach(null, _.omit(options, 'query')));

            if (_.isEmpty(self.myTags)) {
                return when.all(tagOps);
            }

            return Tags.forge().query('whereIn', 'name', _.pluck(self.myTags, 'name')).fetch(options).then(function (existingTags) {
                var doNotExist = [],
                    createAndAttachOperation;

                existingTags = existingTags.toJSON();

                doNotExist = _.reject(self.myTags, function (tag) {
                    return _.any(existingTags, function (existingTag) {
                        return existingTag.name === tag.name;
                    });
                });

                // Create tags that don't exist and attach to post
                _.each(doNotExist, function (tag) {
                    createAndAttachOperation = Tag.add({name: tag.name}, options).then(function (createdTag) {
                        createdTag = createdTag.toJSON();
                        // _.omit(options, 'query') is a fix for using bookshelf 0.6.8
                        // (https://github.com/tgriesser/bookshelf/issues/294)
                        return post.tags().attach(createdTag.id, createdTag.name, _.omit(options, 'query'));
                    });

                    tagOps.push(createAndAttachOperation);
                });

                // attach the tags that already existed
                _.each(existingTags, function (tag) {
                    // _.omit(options, 'query') is a fix for using bookshelf 0.6.8
                    // (https://github.com/tgriesser/bookshelf/issues/294)
                    tagOps.push(post.tags().attach(tag.id, _.omit(options, 'query')));
                });

                return when.all(tagOps);
            });
        });
    },

    // Relations
    author_id: function () {
        return this.belongsTo(User, 'author_id');
    },

    created_by: function () {
        return this.belongsTo(User, 'created_by');
    },

    updated_by: function () {
        return this.belongsTo(User, 'updated_by');
    },

    published_by: function () {
        return this.belongsTo(User, 'published_by');
    },

    tags: function () {
        return this.belongsToMany(Tag);
    },

    fields: function () {
        return this.morphMany(AppField, 'relatable');
    },

    toJSON: function (options) {
        var attrs = ghostBookshelf.Model.prototype.toJSON.call(this, options);

        attrs.author = attrs.author || attrs.author_id;
        delete attrs.author_id;

        return attrs;
    }

}, {

    /**
    * Returns an array of keys permitted in a method's `options` hash, depending on the current method.
    * @param {String} methodName The name of the method to check valid options for.
    * @return {Array} Keys allowed in the `options` hash of the model's method.
    */
    permittedOptions: function (methodName) {
        var options = ghostBookshelf.Model.permittedOptions(),

            // whitelists for the `options` hash argument on methods, by method name.
            // these are the only options that can be passed to Bookshelf / Knex.
            validOptions = {
                findAll: ['withRelated'],
                findOne: ['user', 'importing', 'withRelated'],
                findPage: ['page', 'limit', 'status', 'staticPages'],
                add: ['user', 'importing'],
                edit: ['user']
            };

        if (validOptions[methodName]) {
            options = options.concat(validOptions[methodName]);
        }

        return options;
    },

    /**
     * Filters potentially unsafe model attributes, so you can pass them to Bookshelf / Knex.
     * @param {Object} data Has keys representing the model's attributes/fields in the database.
     * @return {Object} The filtered results of the passed in data, containing only what's allowed in the schema.
     */
    filterData: function (data) {
        var permittedAttributes = this.prototype.permittedAttributes(),
            filteredData;

        // manually add 'tags' attribute since it's not in the schema
        permittedAttributes.push('tags');

        filteredData = _.pick(data, permittedAttributes);

        return filteredData;
    },

    // #### findAll
    // Extends base model findAll to eager-fetch author and user relationships.
    findAll:  function (options) {
        options = options || {};
        options.withRelated = _.union([ 'tags', 'fields' ], options.include);
        return ghostBookshelf.Model.findAll.call(this, options);
    },


     // #### findPage
     // Find results by page - returns an object containing the
     // information about the request (page, limit), along with the
     // info needed for pagination (pages, total).

     // **response:**

     //     {
     //         posts: [
     //         {...}, {...}, {...}
     //     ],
     //     page: __,
     //     limit: __,
     //     pages: __,
     //     total: __
     //     }

    /*
     * @params {Object} options
     */
    findPage: function (options) {
        options = options || {};

        var postCollection = Posts.forge(),
            tagInstance = options.tag !== undefined ? Tag.forge({slug: options.tag}) : false;

        options = this.filterOptions(options, 'findPage');

        // Set default settings for options
        options = _.extend({
            page: 1, // pagination page
            limit: 15,
            staticPages: false, // include static pages
            status: 'published',
            where: {}
        }, options);

        if (options.staticPages !== 'all') {
            // convert string true/false to boolean
            if (!_.isBoolean(options.staticPages)) {
                options.staticPages = options.staticPages === 'true' || options.staticPages === '1' ? true : false;
            }
            options.where.page = options.staticPages;
        }

        // Unless `all` is passed as an option, filter on
        // the status provided.
        if (options.status !== 'all') {
            // make sure that status is valid
            options.status = _.indexOf(['published', 'draft'], options.status) !== -1 ? options.status : 'published';
            options.where.status = options.status;
        }

        // If there are where conditionals specified, add those
        // to the query.
        if (options.where) {
            postCollection.query('where', options.where);
        }

        // Add related objects
        options.withRelated = _.union([ 'tags', 'fields' ], options.include);

        // If a query param for a tag is attached
        // we need to fetch the tag model to find its id
        function fetchTagQuery() {
            if (tagInstance) {
                return tagInstance.fetch();
            }
            return false;
        }

        return when(fetchTagQuery())

            // Set the limit & offset for the query, fetching
            // with the opts (to specify any eager relations, etc.)
            // Omitting the `page`, `limit`, `where` just to be sure
            // aren't used for other purposes.
            .then(function () {
                // If we have a tag instance we need to modify our query.
                // We need to ensure we only select posts that contain
                // the tag given in the query param.
                if (tagInstance) {
                    postCollection
                        .query('join', 'posts_tags', 'posts_tags.post_id', '=', 'posts.id')
                        .query('where', 'posts_tags.tag_id', '=', tagInstance.id);
                }
                return postCollection
                    .query('limit', options.limit)
                    .query('offset', options.limit * (options.page - 1))
                    .query('orderBy', 'status', 'ASC')
                    .query('orderBy', 'published_at', 'DESC')
                    .query('orderBy', 'updated_at', 'DESC')
                    .fetch(_.omit(options, 'page', 'limit'));
            })

            // Fetch pagination information
            .then(function () {
                var qb,
                    tableName = _.result(postCollection, 'tableName'),
                    idAttribute = _.result(postCollection, 'idAttribute');

                // After we're done, we need to figure out what
                // the limits are for the pagination values.
                qb = ghostBookshelf.knex(tableName);

                if (options.where) {
                    qb.where(options.where);
                }

                if (tagInstance) {
                    qb.join('posts_tags', 'posts_tags.post_id', '=', 'posts.id');
                    qb.where('posts_tags.tag_id', '=', tagInstance.id);
                }

                return qb.count(tableName + '.' + idAttribute + ' as aggregate');
            })

            // Format response of data
            .then(function (resp) {
                var totalPosts = parseInt(resp[0].aggregate, 10),
                    calcPages = Math.ceil(totalPosts / options.limit),
                    pagination = {},
                    meta = {},
                    data = {};

                pagination['page'] = parseInt(options.page, 10);
                pagination['limit'] = options.limit;
                pagination['pages'] = calcPages === 0 ? 1 : calcPages;
                pagination['total'] = totalPosts;
                pagination['next'] = null;
                pagination['prev'] = null;

                if (options.include) {
                    _.each(postCollection.models, function (item) {
                        item.include = options.include;
                    });
                }

                data['posts'] = postCollection.toJSON();
                data['meta'] = meta;
                meta['pagination'] = pagination;

                if (pagination.pages > 1) {
                    if (pagination.page === 1) {
                        pagination.next = pagination.page + 1;
                    } else if (pagination.page === pagination.pages) {
                        pagination.prev = pagination.page - 1;
                    } else {
                        pagination.next = pagination.page + 1;
                        pagination.prev = pagination.page - 1;
                    }
                }

                if (tagInstance) {
                    meta['filters'] = {};
                    if (!tagInstance.isNew()) {
                        meta.filters['tags'] = [tagInstance.toJSON()];
                    }
                }

                return data;
            })
            .catch(errors.logAndThrowError);
    },

    //    #### findOne
    //    Extends base model read to eager-fetch author and user relationships.
    findOne: function (args, options) {
        options = options || {};

        args = _.extend({
            status: 'published'
        }, args || {});

        if (args.status === 'all') {
            delete args.status;
        }

        // Add related objects
        options.withRelated = _.union([ 'tags', 'fields' ], options.include);

        return ghostBookshelf.Model.findOne.call(this, args, options);
    },

    add: function (newPostData, options) {
        var self = this;
        options = options || {};

        return ghostBookshelf.Model.add.call(this, newPostData, options).then(function (post) {
            return self.findOne({status: 'all', id: post.id}, options);
        });
    },
    edit: function (editedPost, options) {
        var self = this;
        options = options || {};
        return ghostBookshelf.Model.edit.call(this, editedPost, options).then(function (post) {
            if (post) {
                return self.findOne({status: 'all', id: post.id}, options)
                    .then(function (found) {
                        // Pass along the updated attributes for checking status changes
                        found._updatedAttributes = post._updatedAttributes;
                        return found;
                    });
            }
        });
    },
    destroy: function (_identifier, options) {
        options = this.filterOptions(options, 'destroy');

        return this.forge({id: _identifier}).fetch({withRelated: ['tags']}).then(function destroyTags(post) {
            var tagIds = _.pluck(post.related('tags').toJSON(), 'id');
            if (tagIds) {
                return post.tags().detach(tagIds).then(function destroyPost() {
                    return post.destroy(options);
                });
            }

            return post.destroy(options);
        });
    },

    permissable: function (postModelOrId, context, loadedPermissions, hasUserPermission, hasAppPermission) {
        var self = this,
            postModel = postModelOrId,
            origArgs;

        // If we passed in an id instead of a model, get the model
        // then check the permissions
        if (_.isNumber(postModelOrId) || _.isString(postModelOrId)) {
            // Grab the original args without the first one
            origArgs = _.toArray(arguments).slice(1);
            // Get the actual post model
            return this.findOne({id: postModelOrId, status: 'all'}).then(function (foundPostModel) {
                // Build up the original args but substitute with actual model
                var newArgs = [foundPostModel].concat(origArgs);

                return self.permissable.apply(self, newArgs);
            }, errors.logAndThrowError);
        }

        if (postModel) {
            // If this is the author of the post, allow it.
            hasUserPermission = hasUserPermission || context.user === postModel.get('author_id');
        }

        if (hasUserPermission && hasAppPermission) {
            return when.resolve();
        }

        return when.reject();
    }
});

Posts = ghostBookshelf.Collection.extend({

    model: Post

});

module.exports = {
    Post: Post,
    Posts: Posts
};
