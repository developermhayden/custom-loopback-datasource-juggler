// Copyright IBM Corp. 2013,2016. All Rights Reserved.
// Node module: loopback-datasource-juggler
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

// Turning on strict for this file breaks lots of test cases;
// disabling strict for this file
/* eslint-disable strict */

/*!
 * Module exports class Model
 */
module.exports = ModelBaseClass;

/*!
 * Module dependencies
 */

var g = require('strong-globalize')();
var util = require('util');
var jutil = require('./jutil');
var List = require('./list');
var Hookable = require('./hooks');
var validations = require('./validations');
var _extend = util._extend;
var utils = require('./utils');
var fieldsToArray = utils.fieldsToArray;
var uuid = require('uuid');
var deprecated = require('depd')('loopback-datasource-juggler');
var shortid = require('shortid');

// Set up an object for quick lookup
var BASE_TYPES = {
  'String': true,
  'Boolean': true,
  'Number': true,
  'Date': true,
  'Text': true,
  'ObjectID': true,
};

/**
 * Model class: base class for all persistent objects.
 *
 * `ModelBaseClass` mixes `Validatable` and `Hookable` classes methods
 *
 * @class
 * @param {Object} data Initial object data
 */
function ModelBaseClass(data, options) {
  options = options || {};
  if (!('applySetters' in options)) {
    // Default to true
    options.applySetters = true;
  }
  if (!('applyDefaultValues' in options)) {
    options.applyDefaultValues = true;
  }
  this._initProperties(data, options);
}

/**
 * Initialize the model instance with a list of properties
 * @param {Object} data The data object
 * @param {Object} options An object to control the instantiation
 * @property {Boolean} applySetters Controls if the setters will be applied
 * @property {Boolean} applyDefaultValues Default attributes and values will be applied
 * @property {Boolean} strict Set the instance level strict mode
 * @property {Boolean} persisted Whether the instance has been persisted
 * @private
 */
ModelBaseClass.prototype._initProperties = function(data, options) {
  var self = this;
  var ctor = this.constructor;

  if (data instanceof ctor) {
    // Convert the data to be plain object to avoid pollutions
    data = data.toObject(false);
  }
  var properties = _extend({}, ctor.definition.properties);
  data = data || {};

  if (typeof ctor.applyProperties === 'function') {
    ctor.applyProperties(data);
  }

  options = options || {};
  var applySetters = options.applySetters;
  var applyDefaultValues = options.applyDefaultValues;
  var strict = options.strict;

  if (strict === undefined) {
    strict = ctor.definition.settings.strict;
  }

  var persistUndefinedAsNull = ctor.definition.settings.persistUndefinedAsNull;

  if (ctor.hideInternalProperties) {
    // Object.defineProperty() is expensive. We only try to make the internal
    // properties hidden (non-enumerable) if the model class has the
    // `hideInternalProperties` set to true
    Object.defineProperties(this, {
      __cachedRelations: {
        writable: true,
        enumerable: false,
        configurable: true,
        value: {},
      },

      __data: {
        writable: true,
        enumerable: false,
        configurable: true,
        value: {},
      },

      // Instance level data source
      __dataSource: {
        writable: true,
        enumerable: false,
        configurable: true,
        value: options.dataSource,
      },

      // Instance level strict mode
      __strict: {
        writable: true,
        enumerable: false,
        configurable: true,
        value: strict,
      },

      __persisted: {
        writable: true,
        enumerable: false,
        configurable: true,
        value: false,
      },
    });

    if (strict === 'validate') {
      Object.defineProperty(this, '__unknownProperties', {
        writable: true,
        enumerable: false,
        configrable: true,
        value: [],
      });
    }
  } else {
    this.__cachedRelations = {};
    this.__data = {};
    this.__dataSource = options.dataSource;
    this.__strict = strict;
    this.__persisted = false;
    if (strict === 'validate') {
      this.__unknownProperties = [];
    }
  }

  if (options.persisted !== undefined) {
    this.__persisted = options.persisted === true;
  }

  if (data.__cachedRelations) {
    this.__cachedRelations = data.__cachedRelations;
  }

  var keys = Object.keys(data);

  if (Array.isArray(options.fields)) {
    keys = keys.filter(function(k) {
      return (options.fields.indexOf(k) != -1);
    });
  }

  var size = keys.length;
  var p, propVal;
  for (var k = 0; k < size; k++) {
    p = keys[k];
    propVal = data[p];
    if (typeof propVal === 'function') {
      continue;
    }

    if (propVal === undefined && persistUndefinedAsNull) {
      propVal = null;
    }

    if (properties[p]) {
      // Managed property
      if (applySetters || properties[p].id) {
        self[p] = propVal;
      } else {
        self.__data[p] = propVal;
      }
    } else if (ctor.relations[p]) {
      var relationType = ctor.relations[p].type;

      var modelTo;
      if (!properties[p]) {
        modelTo = ctor.relations[p].modelTo || ModelBaseClass;
        var multiple = ctor.relations[p].multiple;
        var typeName = multiple ? 'Array' : modelTo.modelName;
        var propType = multiple ? [modelTo] : modelTo;
        properties[p] = {name: typeName, type: propType};
        this.setStrict(false);
      }

      // Relation
      if (relationType === 'belongsTo' && propVal != null) {
        // If the related model is populated
        self.__data[ctor.relations[p].keyFrom] = propVal[ctor.relations[p].keyTo];

        if (ctor.relations[p].options.embedsProperties) {
          var fields = fieldsToArray(ctor.relations[p].properties,
            modelTo.definition.properties, modelTo.settings.strict);
          if (!~fields.indexOf(ctor.relations[p].keyTo)) {
            fields.push(ctor.relations[p].keyTo);
          }
          self.__data[p] = new modelTo(propVal, {
            fields: fields,
            applySetters: false,
            persisted: options.persisted,
          });
        }
      }

      self.__cachedRelations[p] = propVal;
    } else {
      // Un-managed property
      if (strict === false || self.__cachedRelations[p]) {
        self[p] = self.__data[p] =
          (propVal !== undefined) ? propVal : self.__cachedRelations[p];

        // Warn about properties with unsupported names
        if (/\./.test(p)) {
          deprecated(g.f('Property names containing a dot are not supported. ' +
            'Model: %s, dynamic property: %s', this.constructor.modelName, p));
        }
      } else if (strict === 'throw') {
        throw new Error(g.f('Unknown property: %s', p));
      } else if (strict === 'validate') {
        // this.__unknownProperties.push(p);
        var obj = {};
        obj[p] = data[p];
        this.__unknownProperties.push(obj);
      }
    }
  }

  keys = Object.keys(properties);

  if (Array.isArray(options.fields)) {
    keys = keys.filter(function(k) {
      return (options.fields.indexOf(k) != -1);
    });
  }

  size = keys.length;

  for (k = 0; k < size; k++) {
    p = keys[k];
    propVal = self.__data[p];
    var type = properties[p].type;

    // Set default values
    if (applyDefaultValues && propVal === undefined) {
      var def = properties[p]['default'];
      if (def !== undefined) {
        if (typeof def === 'function') {
          if (def === Date) {
            // FIXME: We should coerce the value in general
            // This is a work around to {default: Date}
            // Date() will return a string instead of Date
            def = new Date();
          } else {
            def = def();
          }
        } else if (type.name === 'Date' && def === '$now') {
          def = new Date();
        }
        // FIXME: We should coerce the value
        // will implement it after we refactor the PropertyDefinition
        self.__data[p] = propVal = def;
      }
    }

    // Set default value using a named function
    if (applyDefaultValues && propVal === undefined) {
      var defn = properties[p].defaultFn;
      switch (defn) {
        case undefined:
          break;
        case 'guid':
        case 'uuid':
          // Generate a v1 (time-based) id
          propVal = uuid.v1();
          break;
        case 'uuidv4':
          // Generate a RFC4122 v4 UUID
          propVal = uuid.v4();
          break;
        case 'now':
          propVal = new Date();
          break;
        case 'shortid':
          propVal = shortid.generate();
          break;
        default:
          // TODO Support user-provided functions via a registry of functions
          g.warn('Unknown default value provider %s', defn);
      }
      // FIXME: We should coerce the value
      // will implement it after we refactor the PropertyDefinition
      if (propVal !== undefined)
        self.__data[p] = propVal;
    }

    if (propVal === undefined && persistUndefinedAsNull) {
      self.__data[p] = propVal = null;
    }

    // Handle complex types (JSON/Object)
    if (!BASE_TYPES[type.name]) {
      if (typeof self.__data[p] !== 'object' && self.__data[p]) {
        try {
          self.__data[p] = JSON.parse(self.__data[p] + '');
        } catch (e) {
          self.__data[p] = String(self.__data[p]);
        }
      }

      if (type.prototype instanceof ModelBaseClass) {
        if (!(self.__data[p] instanceof type) &&
            typeof self.__data[p] === 'object' &&
            self.__data[p] !== null) {
          self.__data[p] = new type(self.__data[p]);
        }
      } else if (type.name === 'Array' || Array.isArray(type)) {
        if (!(self.__data[p] instanceof List) &&
            self.__data[p] !== undefined &&
            self.__data[p] !== null) {
          self.__data[p] = List(self.__data[p], type, self);
        }
      }
    }
  }
  this.trigger('initialize');
};

/**
 * Define a property on the model.
 * @param {String} prop Property name
 * @param {Object} params Various property configuration
 */
ModelBaseClass.defineProperty = function(prop, params) {
  if (this.dataSource) {
    this.dataSource.defineProperty(this.modelName, prop, params);
  } else {
    this.modelBuilder.defineProperty(this.modelName, prop, params);
  }
};

ModelBaseClass.getPropertyType = function(propName) {
  var prop = this.definition.properties[propName];
  if (!prop) {
    // The property is not part of the definition
    return null;
  }
  if (!prop.type) {
    throw new Error(g.f('Type not defined for property %s.%s', this.modelName, propName));
    // return null;
  }
  return prop.type.name;
};

ModelBaseClass.prototype.getPropertyType = function(propName) {
  return this.constructor.getPropertyType(propName);
};

/**
 * Return string representation of class
 * This overrides the default `toString()` method
 */
ModelBaseClass.toString = function() {
  return '[Model ' + this.modelName + ']';
};

/**
 * Convert model instance to a plain JSON object.
 * Returns a canonical object representation (no getters and setters).
 *
 * @param {Boolean} onlySchema Restrict properties to dataSource only.  Default is false.  If true, the function returns only properties defined in the schema;  Otherwise it returns all enumerable properties.
 */
ModelBaseClass.prototype.toObject = function(onlySchema, removeHidden, removeProtected) {
  if (onlySchema === undefined) {
    onlySchema = true;
  }
  var data = {};
  var self = this;
  var Model = this.constructor;

  // if it is already an Object
  if (Model === Object) {
    return self;
  }

  var strict = this.__strict;
  var schemaLess = (strict === false) || !onlySchema;
  var persistUndefinedAsNull = Model.definition.settings.persistUndefinedAsNull;

  var props = Model.definition.properties;
  var keys = Object.keys(props);
  var propertyName, val;

  for (var i = 0; i < keys.length; i++) {
    propertyName = keys[i];
    val = self[propertyName];

    // Exclude functions
    if (typeof val === 'function') {
      continue;
    }
    // Exclude hidden properties
    if (removeHidden && Model.isHiddenProperty(propertyName)) {
      continue;
    }

    if (removeProtected && Model.isProtectedProperty(propertyName)) {
      continue;
    }

    if (val instanceof List) {
      data[propertyName] = val.toObject(!schemaLess, removeHidden, true);
    } else {
      if (val !== undefined && val !== null && val.toObject) {
        data[propertyName] = val.toObject(!schemaLess, removeHidden, true);
      } else {
        if (val === undefined && persistUndefinedAsNull) {
          val = null;
        }
        data[propertyName] = val;
      }
    }
  }

  if (schemaLess) {
    // Find its own properties which can be set via myModel.myProperty = 'myValue'.
    // If the property is not declared in the model definition, no setter will be
    // triggered to add it to __data
    keys = Object.keys(self);
    var size = keys.length;
    for (i = 0; i < size; i++) {
      propertyName = keys[i];
      if (props[propertyName]) {
        continue;
      }
      if (propertyName.indexOf('__') === 0) {
        continue;
      }
      if (removeHidden && Model.isHiddenProperty(propertyName)) {
        continue;
      }
      if (removeProtected && Model.isProtectedProperty(propertyName)) {
        continue;
      }
      if (data[propertyName] !== undefined) {
        continue;
      }
      val = self[propertyName];
      if (val !== undefined) {
        if (typeof val === 'function') {
          continue;
        }
        if (val !== null && val.toObject) {
          data[propertyName] = val.toObject(!schemaLess, removeHidden, true);
        } else {
          data[propertyName] = val;
        }
      } else if (persistUndefinedAsNull) {
        data[propertyName] = null;
      }
    }
    // Now continue to check __data
    keys = Object.keys(self.__data);
    size = keys.length;
    for (i = 0; i < size; i++) {
      propertyName = keys[i];
      if (propertyName.indexOf('__') === 0) {
        continue;
      }
      if (data[propertyName] === undefined) {
        if (removeHidden && Model.isHiddenProperty(propertyName)) {
          continue;
        }
        if (removeProtected && Model.isProtectedProperty(propertyName)) {
          continue;
        }
        var ownVal = self[propertyName];
        // The ownVal can be a relation function
        val = (ownVal !== undefined && (typeof ownVal !== 'function')) ? ownVal : self.__data[propertyName];
        if (typeof val === 'function') {
          continue;
        }

        if (val !== undefined && val !== null && val.toObject) {
          data[propertyName] = val.toObject(!schemaLess, removeHidden, true);
        } else if (val === undefined && persistUndefinedAsNull) {
          data[propertyName] = null;
        } else {
          data[propertyName] = val;
        }
      }
    }
  }

  return data;
};

ModelBaseClass.isProtectedProperty = function(propertyName) {
  var Model = this;
  var settings = Model.definition && Model.definition.settings;
  var protectedProperties = settings && (settings.protectedProperties || settings.protected);
  if (Array.isArray(protectedProperties)) {
    // Cache the protected properties as an object for quick lookup
    settings.protectedProperties = {};
    for (var i = 0; i < protectedProperties.length; i++) {
      settings.protectedProperties[protectedProperties[i]] = true;
    }
    protectedProperties = settings.protectedProperties;
  }
  if (protectedProperties) {
    return protectedProperties[propertyName];
  } else {
    return false;
  }
};

ModelBaseClass.isHiddenProperty = function(propertyName) {
  var Model = this;
  var settings = Model.definition && Model.definition.settings;
  var hiddenProperties = settings && (settings.hiddenProperties || settings.hidden);
  if (Array.isArray(hiddenProperties)) {
    // Cache the hidden properties as an object for quick lookup
    settings.hiddenProperties = {};
    for (var i = 0; i < hiddenProperties.length; i++) {
      settings.hiddenProperties[hiddenProperties[i]] = true;
    }
    hiddenProperties = settings.hiddenProperties;
  }
  if (hiddenProperties) {
    return hiddenProperties[propertyName];
  } else {
    return false;
  }
};

ModelBaseClass.prototype.toJSON = function() {
  return this.toObject(false, true, false);
};

ModelBaseClass.prototype.fromObject = function(obj) {
  for (var key in obj) {
    this[key] = obj[key];
  }
};

/**
 * Reset dirty attributes.
 * This method does not perform any database operations; it just resets the object to its
 * initial state.
 */
ModelBaseClass.prototype.reset = function() {
  var obj = this;
  for (var k in obj) {
    if (k !== 'id' && !obj.constructor.dataSource.definitions[obj.constructor.modelName].properties[k]) {
      delete obj[k];
    }
  }
};

// Node v0.11+ allows custom inspect functions to return an object
// instead of string. That way options like `showHidden` and `colors`
// can be preserved.
var versionParts = process.versions && process.versions.node ?
  process.versions.node.split(/\./g).map(function(v) { return +v; }) :
  [1, 0, 0]; // browserify ships 1.0-compatible version of util.inspect

var INSPECT_SUPPORTS_OBJECT_RETVAL =
 versionParts[0] > 0 ||
 versionParts[1] > 11 ||
 (versionParts[0] === 11 && versionParts[1] >= 14);

ModelBaseClass.prototype.inspect = function(depth) {
  if (INSPECT_SUPPORTS_OBJECT_RETVAL)
    return this.__data;

  // Workaround for older versions
  // See also https://github.com/joyent/node/commit/66280de133
  return util.inspect(this.__data, {
    showHidden: false,
    depth: depth,
    colors: false,
  });
};

ModelBaseClass.mixin = function(anotherClass, options) {
  if (typeof anotherClass === 'string') {
    this.modelBuilder.mixins.applyMixin(this, anotherClass, options);
  } else {
    if (anotherClass.prototype instanceof ModelBaseClass) {
      var props = anotherClass.definition.properties;
      for (var i in props) {
        if (this.definition.properties[i]) {
          continue;
        }
        this.defineProperty(i, props[i]);
      }
    }
    return jutil.mixin(this, anotherClass, options);
  }
};

ModelBaseClass.prototype.getDataSource = function() {
  return this.__dataSource || this.constructor.dataSource;
};

ModelBaseClass.getDataSource = function() {
  return this.dataSource;
};

ModelBaseClass.prototype.setStrict = function(strict) {
  this.__strict = strict;
};

// Mixin observer
jutil.mixin(ModelBaseClass, require('./observer'));

jutil.mixin(ModelBaseClass, Hookable);
jutil.mixin(ModelBaseClass, validations.Validatable);
