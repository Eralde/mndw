interface PropertyDescriptorWithAccessors {
  configurable?: boolean;
  enumerable?: boolean;
  get?: (this: object) => unknown;
  set?: (this: object, value: unknown) => void;
}

interface PropertyLocation {
  prototype: object;
  descriptor: PropertyDescriptorWithAccessors;
}

interface PropertyTracker {
  dirty: boolean;
  internal: boolean;
}

const trackers = new WeakMap<HTMLElement, Map<string, PropertyTracker>>();
const wrappedProperties = new WeakMap<object, Map<string, PropertyDescriptorWithAccessors>>();

export interface LocalizedPropertyState<T> {
  readonly dirty: boolean;
  setGenerated(value: T): void;
}

export interface GeneratedAttributeState {
  readonly dirty: boolean;
  setGenerated(value: string | null): void;
}

function findPropertyDescriptor(host: HTMLElement, property: string): PropertyLocation | undefined {
  let prototype: object | null = Object.getPrototypeOf(host);

  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);

    if (descriptor !== undefined) {
      return {prototype, descriptor};
    }

    prototype = Object.getPrototypeOf(prototype);
  }

  return undefined;
}

function trackerFor(host: HTMLElement, property: string): PropertyTracker | undefined {
  return trackers.get(host)?.get(property);
}

function wrapProperty(location: PropertyLocation, property: string): void {
  let properties = wrappedProperties.get(location.prototype);

  if (properties?.has(property)) {
    return;
  }

  if (properties === undefined) {
    properties = new Map();
    wrappedProperties.set(location.prototype, properties);
  }

  properties.set(property, location.descriptor);

  Object.defineProperty(location.prototype, property, {
    configurable: location.descriptor.configurable,
    enumerable: location.descriptor.enumerable,
    get: function(this: HTMLElement): unknown {
      return location.descriptor.get?.call(this);
    },
    set: function(this: HTMLElement, value: unknown): void {
      const tracker = trackerFor(this, property);

      if (tracker !== undefined && !tracker.internal) {
        tracker.dirty = true;
      }

      location.descriptor.set?.call(this, value);
    },
  });
}

function trackAttribute(
  host: HTMLElement,
  attribute: string,
  onExternalWrite: () => void,
): (callback: () => void) => void {
  let internal = false;
  const originalSetAttribute = host.setAttribute.bind(host);
  const originalRemoveAttribute = host.removeAttribute.bind(host);
  const originalToggleAttribute = host.toggleAttribute.bind(host);

  Object.defineProperty(host, 'setAttribute', {
    configurable: true,
    value: (name: string, value: string): void => {
      if (name === attribute && !internal) {
        onExternalWrite();
      }

      originalSetAttribute(name, value);
    },
  });
  Object.defineProperty(host, 'removeAttribute', {
    configurable: true,
    value: (name: string): void => {
      if (name === attribute && !internal) {
        onExternalWrite();
      }

      originalRemoveAttribute(name);
    },
  });
  Object.defineProperty(host, 'toggleAttribute', {
    configurable: true,
    value: (name: string, force?: boolean): boolean => {
      if (name === attribute && !internal) {
        onExternalWrite();
      }

      return originalToggleAttribute(name, force);
    },
  });

  return (callback: () => void): void => {
    internal = true;

    try {
      callback();
    } finally {
      internal = false;
    }
  };
}

export function createLocalizedProperty<T>(
  host: HTMLElement,
  property: string,
  attribute = property,
): LocalizedPropertyState<T> {
  const location = findPropertyDescriptor(host, property);

  if (location?.descriptor.set === undefined || location.descriptor.get === undefined) {
    throw new Error(`Property ${property} has no accessor on ${host.localName}`);
  }

  wrapProperty(location, property);

  const tracker: PropertyTracker = {
    dirty: host.hasAttribute(attribute),
    internal: false,
  };
  const hostTrackers = trackers.get(host) ?? new Map<string, PropertyTracker>();

  hostTrackers.set(property, tracker);
  trackers.set(host, hostTrackers);

  const withInternalAttributeWrite = trackAttribute(host, attribute, () => {
    tracker.dirty = true;
  });

  return {
    get dirty(): boolean {
      return tracker.dirty;
    },
    setGenerated(value: T): void {
      if (tracker.dirty) {
        return;
      }

      withInternalAttributeWrite(() => {
        tracker.internal = true;

        try {
          location.descriptor.set?.call(host, value);
        } finally {
          tracker.internal = false;
        }
      });
    },
  };
}

export function createGeneratedAttribute(host: HTMLElement, attribute: string): GeneratedAttributeState {
  let dirty = host.hasAttribute(attribute);
  const withInternalAttributeWrite = trackAttribute(host, attribute, () => {
    dirty = true;
  });

  return {
    get dirty(): boolean {
      return dirty;
    },
    setGenerated(value: string | null): void {
      if (dirty) {
        return;
      }

      withInternalAttributeWrite(() => {
        if (value === null) {
          host.removeAttribute(attribute);
        } else {
          host.setAttribute(attribute, value);
        }
      });
    },
  };
}
