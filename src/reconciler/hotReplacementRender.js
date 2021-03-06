import levenshtein from 'fast-levenshtein'
import { PROXY_IS_MOUNTED, PROXY_KEY, UNWRAP_PROXY } from '../proxy'
import {
  getIdByType,
  getProxyByType,
  isRegisteredComponent,
  isTypeBlacklisted,
  updateProxyById,
} from './proxies'
import {
  updateInstance,
  getComponentDisplayName,
  isFragmentNode,
  isContextConsumer,
  isContextProvider,
  getContextProvider,
  isReactClass,
  isReactClassInstance,
  CONTEXT_CURRENT_VALUE,
  isMemoType,
  isLazyType,
  isForwardType,
} from '../internal/reactUtils'
import reactHotLoader from '../reactHotLoader'
import logger from '../logger'

// some `empty` names, React can autoset display name to...
const UNDEFINED_NAMES = {
  Unknown: true,
  Component: true,
}

let renderStack = []

const stackReport = () => {
  const rev = renderStack.slice().reverse()
  logger.warn('in', rev[0].name, rev)
}

const emptyMap = new Map()
const stackContext = () =>
  (renderStack[renderStack.length - 1] || {}).context || emptyMap
const areNamesEqual = (a, b) =>
  a === b || (UNDEFINED_NAMES[a] && UNDEFINED_NAMES[b])
const shouldUseRenderMethod = fn =>
  fn && (isReactClassInstance(fn) || fn.SFC_fake)

const isFunctional = fn => typeof fn === 'function'
const isArray = fn => Array.isArray(fn)
const asArray = a => (isArray(a) ? a : [a])
const getTypeOf = type => {
  if (isReactClass(type)) return 'ReactComponent'
  if (isFunctional(type)) return 'StatelessFunctional'
  return 'Fragment' // ?
}

const filterNullArray = a => {
  if (!a) return []
  return a.filter(x => !!x)
}

const unflatten = a =>
  a.reduce((acc, a) => {
    if (Array.isArray(a)) {
      acc.push(...unflatten(a))
    } else {
      acc.push(a)
    }
    return acc
  }, [])

const getElementType = child =>
  child.type[UNWRAP_PROXY] ? child.type[UNWRAP_PROXY]() : child.type

const haveTextSimilarity = (a, b) =>
  // equal or slight changed
  a === b || levenshtein.get(a, b) < a.length * 0.2

const equalClasses = (a, b) => {
  const prototypeA = a.prototype
  const prototypeB = Object.getPrototypeOf(b.prototype)

  let hits = 0
  let misses = 0
  let comparisons = 0
  Object.getOwnPropertyNames(prototypeA).forEach(key => {
    const descriptorA = Object.getOwnPropertyDescriptor(prototypeA, key)
    const valueA =
      descriptorA && (descriptorA.value || descriptorA.get || descriptorA.set)
    const descriptorB = Object.getOwnPropertyDescriptor(prototypeB, key)
    const valueB =
      descriptorB && (descriptorB.value || descriptorB.get || descriptorB.set)

    if (typeof valueA === 'function' && key !== 'constructor') {
      comparisons++
      if (haveTextSimilarity(String(valueA), String(valueB))) {
        hits++
      } else {
        misses++
        if (key === 'render') {
          misses++
        }
      }
    }
  })
  // allow to add or remove one function
  return (hits > 0 && misses <= 1) || comparisons === 0
}

export const areSwappable = (a, b) => {
  // both are registered components and have the same name
  if (getIdByType(b) && getIdByType(a) === getIdByType(b)) {
    return true
  }
  if (getTypeOf(a) !== getTypeOf(b)) {
    return false
  }
  if (isReactClass(a)) {
    return (
      areNamesEqual(getComponentDisplayName(a), getComponentDisplayName(b)) &&
      equalClasses(a, b)
    )
  }

  if (isFunctional(a)) {
    const nameA = getComponentDisplayName(a)
    return (
      (areNamesEqual(nameA, getComponentDisplayName(b)) &&
        nameA !== 'Component') ||
      haveTextSimilarity(String(a), String(b))
    )
  }
  return false
}

const render = component => {
  if (!component) {
    return []
  }
  if (shouldUseRenderMethod(component)) {
    // not calling real render method to prevent call recursion.
    // stateless components does not have hotComponentRender
    return component.hotComponentRender
      ? component.hotComponentRender()
      : component.render()
  }
  if (isForwardType(component)) {
    return component.type.render(component.props, null)
  }
  if (isArray(component)) {
    return component.map(render)
  }
  if (component.children) {
    return component.children
  }

  return []
}

const NO_CHILDREN = { children: [] }
const mapChildren = (children, instances) => ({
  children: children.filter(c => c).map((child, index) => {
    if (typeof child !== 'object' || child.isMerged) {
      return child
    }
    const instanceLine = instances[index] || {}
    const oldChildren = asArray(instanceLine.children || [])

    if (Array.isArray(child)) {
      return {
        type: null,
        ...mapChildren(child, oldChildren),
      }
    }

    const newChildren = asArray(
      (child.props && child.props.children) || child.children || [],
    )
    const nextChildren =
      child.type !== 'function' &&
      oldChildren.length &&
      mapChildren(newChildren, oldChildren)

    return {
      nextProps: child.props,
      isMerged: true,
      ...instanceLine,
      // actually child merge is needed only for "HTML TAG"s, and usually don't work for Components.
      // the children from an instance or rendered children
      // while children from a props is just a props.
      // they could not exists. they could differ.
      ...(nextChildren || {}),
      type: child.type,
    }
  }),
})

const mergeInject = (a, b, instance) => {
  if (a && !Array.isArray(a)) {
    return mergeInject([a], b)
  }
  if (b && !Array.isArray(b)) {
    return mergeInject(a, [b])
  }

  if (!a || !b) {
    return NO_CHILDREN
  }
  if (a.length === b.length) {
    return mapChildren(a, b)
  }

  // in some cases (no confidence here) B could contain A except null children
  // in some cases - could not.
  // this depends on React version and the way you build component.

  const nonNullA = filterNullArray(a)
  if (nonNullA.length === b.length) {
    return mapChildren(nonNullA, b)
  }

  const flatA = unflatten(nonNullA)
  const flatB = unflatten(b)
  if (flatA.length === flatB.length) {
    return mapChildren(flatA, flatB)
  }
  if (
    flatB.length === 0 &&
    flatA.length === 1 &&
    typeof flatA[0] !== 'object'
  ) {
    // terminal node
  } else {
    logger.warn(
      `React-hot-loader: unable to merge `,
      a,
      'and children of ',
      instance,
    )
    stackReport()
  }
  return NO_CHILDREN
}

const transformFlowNode = flow =>
  flow.reduce((acc, node) => {
    if (node && isFragmentNode(node)) {
      if (node.props && node.props.children) {
        return [...acc, ...filterNullArray(asArray(node.props.children))]
      }
      if (node.children) {
        return [...acc, ...filterNullArray(asArray(node.children))]
      }
    }
    return [...acc, node]
  }, [])

let scheduledUpdates = []
let scheduledUpdate = 0

export const flushScheduledUpdates = () => {
  const instances = scheduledUpdates
  scheduledUpdates = []
  scheduledUpdate = 0
  instances.forEach(
    instance => instance[PROXY_IS_MOUNTED] && updateInstance(instance),
  )
}

export const unscheduleUpdate = instance => {
  scheduledUpdates = scheduledUpdates.filter(inst => inst !== instance)
}

const scheduleInstanceUpdate = instance => {
  scheduledUpdates.push(instance)
  if (!scheduledUpdate) {
    scheduledUpdate = setTimeout(flushScheduledUpdates, 4)
  }
}

const hotReplacementRender = (instance, stack) => {
  if (isReactClassInstance(instance)) {
    const type = getElementType(stack)

    renderStack.push({
      name: getComponentDisplayName(type),
      type,
      props: stack.instance.props,
      context: stackContext(),
    })
  }

  try {
    const flow = transformFlowNode(filterNullArray(asArray(render(instance))))

    const { children } = stack

    flow.forEach((child, index) => {
      const stackChild = children[index]
      const next = instance => {
        // copy over props as long new component may be hidden inside them
        // child does not have all props, as long some of them can be calculated on componentMount.
        const realProps = instance.props
        const nextProps = {
          ...realProps,
          ...(child.nextProps || {}),
          ...(child.props || {}),
        }

        if (isReactClassInstance(instance) && instance.componentWillUpdate) {
          // Force-refresh component (bypass redux renderedComponent)
          instance.componentWillUpdate({ ...realProps }, instance.state)
        }
        instance.props = nextProps
        hotReplacementRender(instance, stackChild)
        instance.props = realProps
      }

      // text node
      if (typeof child !== 'object' || !stackChild || !stackChild.instance) {
        if (stackChild && stackChild.children && stackChild.children.length) {
          logger.error(
            'React-hot-loader: reconciliation failed',
            'could not dive into [',
            child,
            '] while some elements are still present in the tree.',
          )
          stackReport()
        }
        return
      }

      if (typeof child.type !== typeof stackChild.type) {
        // Portals could generate undefined !== null
        if (child.type && stackChild.type) {
          logger.warn(
            'React-hot-loader: got ',
            child.type,
            'instead of',
            stackChild.type,
          )
          stackReport()
        }
        return
      }

      if (isMemoType(child) || isLazyType(child)) {
        // force update memo children
        scheduleInstanceUpdate(stackChild.children[0].instance)
      }

      if (isForwardType(child)) {
        next(stackChild.instance)
      } else if (isContextConsumer(child)) {
        try {
          next({
            children: (child.props ? child.props.children : child.children[0])(
              stackContext().get(child.type) ||
                child.type[CONTEXT_CURRENT_VALUE],
            ),
          })
        } catch (e) {
          // do nothing, yet
        }
      } else if (typeof child.type !== 'function') {
        // React
        let childName = child.type
          ? getComponentDisplayName(child.type)
          : 'empty'
        let extraContext = stackContext()

        if (isContextProvider(child)) {
          extraContext = new Map(extraContext)
          extraContext.set(
            getContextProvider(child.type),
            {
              ...(child.nextProps || {}),
              ...(child.props || {}),
            }.value,
          )
          childName = 'ContextProvider'
        }

        renderStack.push({
          name: childName,
          type: child.type,
          props: stack.instance.props,
          context: extraContext,
        })

        next(
          // move types from render to the instances of hydrated tree
          mergeInject(
            transformFlowNode(
              asArray(child.props ? child.props.children : child.children),
            ),
            stackChild.instance.children,
            stackChild.instance,
          ),
        )
        renderStack.pop()
      } else {
        if (child.type === stackChild.type) {
          next(stackChild.instance)
        } else {
          // unwrap proxy
          const childType = getElementType(child)
          if (!stackChild.type[PROXY_KEY]) {
            if (isTypeBlacklisted(stackChild.type)) {
              logger.warn(
                'React-hot-loader: cold element got updated ',
                stackChild.type,
              )
              return
            }
            /* eslint-disable no-console */
            logger.error(
              'React-hot-loader: fatal error caused by ',
              stackChild.type,
              ' - no instrumentation found. ',
              'Please require react-hot-loader before React. More in troubleshooting.',
            )
            stackReport()
            throw new Error('React-hot-loader: wrong configuration')
          }

          if (
            isRegisteredComponent(childType) ||
            isRegisteredComponent(stackChild.type)
          ) {
            // one of elements are registered via babel plugin, and should not be handled by hot swap
          } else if (areSwappable(childType, stackChild.type)) {
            // they are both registered, or have equal code/displayname/signature

            // update proxy using internal PROXY_KEY
            updateProxyById(stackChild.type[PROXY_KEY], childType)

            next(stackChild.instance)
          } else {
            logger.warn(
              `React-hot-loader: a ${getComponentDisplayName(
                childType,
              )} was found where a ${getComponentDisplayName(
                stackChild,
              )} was expected.
          ${childType}`,
            )
            stackReport()
          }
        }

        scheduleInstanceUpdate(stackChild.instance)
      }
    })
  } catch (e) {
    if (e.then) {
      // this is probably Suspense. Do nothing
    } else {
      logger.warn('React-hot-loader: run time error during reconciliation', e)
    }
  }

  if (isReactClassInstance(instance)) {
    renderStack.pop()
  }
}

export const hotComponentCompare = (oldType, newType) => {
  if (oldType === newType) {
    return true
  }

  if (areSwappable(newType, oldType)) {
    getProxyByType(newType[UNWRAP_PROXY]()).dereference()
    updateProxyById(oldType[PROXY_KEY], newType[UNWRAP_PROXY]())
    updateProxyById(newType[PROXY_KEY], oldType[UNWRAP_PROXY]())
    return true
  }

  return false
}

export default (instance, stack) => {
  try {
    // disable reconciler to prevent upcoming components from proxying.
    reactHotLoader.disableProxyCreation = true
    renderStack = []
    hotReplacementRender(instance, stack)
  } catch (e) {
    logger.warn('React-hot-loader: reconcilation failed due to error', e)
  } finally {
    reactHotLoader.disableProxyCreation = false
  }
}
