import onFinished from 'on-finished';
import { format } from 'util';
import clockit from 'clockit';
import md5 from 'md5';
import { getNamedType } from 'graphql';

/**
 * A default client
 * Logs to console
 *
 * @return object
 */
const getDefaultClient = () => {
  console.warn('Using default graphqlStatsd client!');
  return {
    increment: (name, value, sampleRate, tags, callback) => {
      console.info('graphqlStatsd:increment');
      console.log(name, value, sampleRate, tags);
      if (callback && typeof callback === 'function') {
        return callback();
      }
    },
    timing: (name, value, sampleRate, tags, callback) => {
      console.info('graphqlStatsd:timing');
      console.log(name, value, sampleRate, tags);
      if (callback && typeof callback === 'function') {
        return callback();
      }
    }
  };
};

export default class {

  /**
   * Create a new GraphQL Statsd Client
   * @param  object statsdClient
   * @return void
   */
  constructor(statsdClient = getDefaultClient()) {
    if (!statsdClient) {
      throw new Error('StatsdClient is required');
    }

    if (!statsdClient.timing || typeof statsdClient.timing !== 'function') {
      throw new Error('StatsdClient must implement timing method');
    }

    if (!statsdClient.increment ||
      typeof statsdClient.increment !== 'function') {
      throw new Error('StatsdClient must implement increment method');
    }

    this.statsdClient = statsdClient;
  }

  /**
   * The sample rate to use for statsd reporting
   *
   * @return float
   */
  get sampleRate() {
    return this._sampleRate ? this._sampleRate : 0.1;
  }

  /**
   * Set the sample rate to use for statsd reporting
   *
   * @param  float value
   * @return void
   */
  set sampleRate(value) {
    this._sampleRate = value;
  }

  /**
   * Decorate individual GraphQL resolvers
   *
   * Adds timers and increments
   *
   * @param  function resolver
   * @param  object fieldInfo
   * @return mixed
   */
  decorateResolver(resolver, fieldInfo) {
    return (p, a, ctx, resolverInfo) => {
      const context = ctx.graphqlStatsdContext ?
        ctx.graphqlStatsdContext : undefined;
      if (!context) {
        console.warn('graphqlStatsd: Context is undefined!');
      }

      // Send the resolve stat
      const statResolve = err => {
        let tags = [];
        if (fieldInfo.statsdTags) {
          tags = tags.concat(fieldInfo.statsdTags);
        }

        if (err) {
          // In case Apollo Error is used, send the err.data.type
          tags.push(format('error:%s', err.data ? err.data.type : err.name));
        }

        if (context) {
          if (Array.isArray(context.queries)) {
            context.operationName = context
              .queries[context.queryHash]
              .operationName;
          }
          tags.push(format('queryHash:%s', context.queryHash));
          tags.push(format('operationName:%s', context.operationName));
        }
        tags.push(format('resolveName:%s', fieldInfo.name ?
          fieldInfo.name : 'undefined'));

        if (err) {
          this.statsdClient.increment('resolve_error',
            1,
            this.sampleRate,
            tags);
        }
      };

      // Heavily inspired by:
      // apollographql/optics-agent-js
      // https://git.io/vDL9p

      let result;
      try {
        result = resolver(p, a, ctx, resolverInfo);
      } catch (e) {
        statResolve(e);
        throw e;
      }

      try {
        if (result && typeof result.then === 'function') {
          result.then(res => {
            statResolve();
            return res;
          }).catch(err => {
            statResolve(err);
            throw err;
          });
          return result;
        } else if (Array.isArray(result)) {
          const promises = [];
          result.forEach(value => {
            if (value && typeof value.then === 'function') {
              promises.push(value);
            }
          });
          if (promises.length > 0) {
            Promise.all(promises).then(() => {
              statResolve();
            }).catch(err => {
              statResolve(err);
              throw err;
            });
            return result;
          }
        }

        statResolve();
        return result;
      } catch (e) {
        statResolve(e);
        return result;
      }

      statResolve();
      return result;
    };
  }

  /**
   * Decorate the schema with decorated resolvers
   *
   * @param GraphQLSchema schema
   * @return GraphQLSchema
   */
  decorateSchema(schema) {
    var typeMap = schema.getTypeMap();
    Object.keys(typeMap).forEach(typeName => {
      var type = typeMap[typeName];
      if (!getNamedType(type).name.startsWith('__') && type.getFields) {
        var fields = type.getFields();
        Object.keys(fields).forEach(fieldName => {
          var field = fields[fieldName];
          if (field.resolve) {
            field.resolve = this.decorateResolver(field.resolve, field);
          }
        });
      }
    });

    return schema;
  }

  /**
   * Get express middleware to handle incomming requests
   *
   * @param config object that can hold:
   *   - tagQueryHash: if true metrics will be tagged with queryHash
   *   - tagOperationName: if true metrics will be tagged with operationName
   *   if config is not available,
   *   metrics will be tagged with queryHash and operationName
   *   if config is available metrics will only be tagged
   *   with available options, missing options is equivalent to false
   * @return function
   */
  getExpressMiddleware(config) {
    return (req, res, next) => {
      const timer = clockit.start();

      let tagQueryHash = [];
      let tagOperationName = [];

      // We should be able to separate the queries,
      // whether they are given by GET or POST.

      if (req.query && req.query.query) {
        let queryHash = md5(req.query.query);
        let operationName = req.query.operationName || '';

        req.graphqlStatsdContext = {
          queryHash, operationName
        };

        tagQueryHash.push(queryHash);
        tagOperationName.push(operationName);
      }

      // In case the incoming body is bundled queries.
      if (Array.isArray(req.body)) {
        req.graphqlStatsdContext = {};
        req.graphqlStatsdContext.queries = [];
        req.body.forEach(queryObject => {
          queryObject.queryHash = md5(queryObject.query);
          req.graphqlStatsdContext.queries[queryObject.queryHash] = queryObject;

          tagQueryHash.push(queryObject.queryHash);
          tagOperationName.push(queryObject.operationName);
        });
      } else if (req.body.query) {
        req.graphqlStatsdContext = {
          queryHash: req.body.query ? md5(req.body.query) : null,
          operationName: req.body.operationName ? req.body.operationName : null
        };

        tagQueryHash.push(req.graphqlStatsdContext.queryHash);
        tagOperationName.push(req.graphqlStatsdContext.operationName);
      }

      var tags = [];

      if (!config || config.tagQueryHash) {
        tags.push(format('queryHash:%s',
          tagQueryHash.join('/').slice(0, 200)));
      }

      if (!config || config.tagOperationName) {
        tags.push(format('operationName:%s',
          tagOperationName.join('/').slice(0, 200)));
      }

      onFinished(res, () => {
        this.statsdClient.timing(
          'response_time',
          timer.ms,
          this.sampleRate,
          tags
        );
      });
      next();
    };
  }
}
