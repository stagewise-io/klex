export const CONSOLE_FACTORY_SOURCE = String.raw`
((emit) => {
  "use strict";

  const MAX_DEPTH = 4;
  const MAX_ENTRIES = 50;
  const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  const safeString = (value) => {
    try {
      return String(value);
    } catch (error) {
      return '[Uninspectable: ' + errorMessage(error) + ']';
    }
  };

  const errorMessage = (error) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
      return descriptor && typeof descriptor.value === 'string'
        ? descriptor.value
        : 'inspection failed';
    } catch {
      return 'inspection failed';
    }
  };

  const numberText = (value) => {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    if (Object.is(value, -0)) return '-0';
    return String(value);
  };

  const propertyName = (key) => {
    if (typeof key === 'symbol') return '[' + safeString(key) + ']';
    return identifierPattern.test(key) ? key : JSON.stringify(key);
  };

  const accessorText = (descriptor) => {
    if (descriptor.get && descriptor.set) return '[Getter/Setter]';
    if (descriptor.get) return '[Getter]';
    return '[Setter]';
  };

  const constructorName = (value) => {
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype === null || prototype === Object.prototype) return '';
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
      return descriptor && typeof descriptor.value === 'function'
        ? descriptor.value.name || ''
        : '';
    } catch {
      return '';
    }
  };

  const inspect = (value, depth, seen, quoteStrings = true) => {
    try {
      if (value === null) return 'null';
      switch (typeof value) {
        case 'undefined':
          return 'undefined';
        case 'string':
          return quoteStrings ? JSON.stringify(value) : value;
        case 'boolean':
          return String(value);
        case 'number':
          return numberText(value);
        case 'bigint':
          return String(value) + 'n';
        case 'symbol':
          return safeString(value);
        case 'function':
          return '[Function' + (value.name ? ': ' + value.name : '') + ']';
      }

      if (seen.has(value)) return '[Circular]';
      if (depth >= MAX_DEPTH)
        return Array.isArray(value) ? '[Array]' : '[Object]';

      seen.add(value);
      try {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (value instanceof Error) {
          const name = descriptors.name && 'value' in descriptors.name
            ? safeString(descriptors.name.value)
            : constructorName(value) || 'Error';
          const message = descriptors.message && 'value' in descriptors.message
            ? safeString(descriptors.message.value)
            : '';
          return name + (message ? ': ' + message : '');
        }

        if (Array.isArray(value)) {
          const lengthDescriptor = descriptors.length;
          const length = lengthDescriptor && 'value' in lengthDescriptor
            ? Number(lengthDescriptor.value)
            : 0;
          const count = Math.min(length, MAX_ENTRIES);
          const entries = [];
          for (let index = 0; index < count; index += 1) {
            const descriptor = descriptors[index];
            if (!descriptor) entries.push('<empty>');
            else if ('value' in descriptor)
              entries.push(inspect(descriptor.value, depth + 1, seen));
            else entries.push(accessorText(descriptor));
          }
          if (length > count) entries.push('... ' + (length - count) + ' more items');
          return '[ ' + entries.join(', ') + ' ]';
        }

        const keys = Reflect.ownKeys(descriptors).filter(
          (key) => key !== 'stack' && key !== 'message',
        );
        const selected = keys.slice(0, MAX_ENTRIES);
        const entries = selected.map((key) => {
          const descriptor = descriptors[key];
          const rendered = descriptor && 'value' in descriptor
            ? inspect(descriptor.value, depth + 1, seen)
            : accessorText(descriptor);
          return propertyName(key) + ': ' + rendered;
        });
        if (keys.length > selected.length)
          entries.push('... ' + (keys.length - selected.length) + ' more properties');
        const name = constructorName(value);
        return (name ? name + ' ' : '') + '{ ' + entries.join(', ') + ' }';
      } finally {
        seen.delete(value);
      }
    } catch (error) {
      return '[Uninspectable: ' + errorMessage(error) + ']';
    }
  };

  const inspectArgument = (value) => inspect(value, 0, new Set(), false);

  const formatToken = (token, value) => {
    switch (token) {
      case '%s':
        return safeString(value);
      case '%d':
      case '%f': {
        try {
          return numberText(Number(value));
        } catch {
          return 'NaN';
        }
      }
      case '%i': {
        try {
          return numberText(Number.parseInt(value, 10));
        } catch {
          return 'NaN';
        }
      }
      case '%o':
      case '%O':
        return inspectArgument(value);
      default:
        return token;
    }
  };

  const format = (data) => {
    if (data.length === 0) return '';
    let nextArgument = 0;
    let line = '';
    if (typeof data[0] === 'string') {
      nextArgument = 1;
      line = data[0].replace(/%[sdifoO%]/g, (token) => {
        if (token === '%%') return '%';
        if (nextArgument >= data.length) return token;
        return formatToken(token, data[nextArgument++]);
      });
    }
    const remaining = data.slice(nextArgument).map(inspectArgument);
    if (line && remaining.length > 0) return line + ' ' + remaining.join(' ');
    if (line) return line;
    return remaining.join(' ');
  };

  const log = (...data) => emit(format(data));
  Object.freeze(log);
  return Object.freeze({ log });
})
`;
