import Port = chrome.runtime.Port
import { acceptableTimeDifferenceBetweenClientsInMS, eventCoolDown } from './config'

let lastEventTime = Date.now()

const asyncSendMessage = (message: any) => {
  return new Promise<any>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (result) => {
      if (result.error) {
        reject(new Error('An error occurred in the background script:\n' + result.error.stack))
      } else {
        resolve(result)
      }
    })
  })
}

const registerNewSession = async (): Promise<string> => {
  try {
    const { result: uuid } = await asyncSendMessage({
      query: 'createSession',
    })

    return uuid
  } catch (e) {
    if (e.message.includes('Failed to fetch')) {
      throw new Error('Failed to register new session because background fetch failed. Perhaps ' +
        'the server is offline?')
    } else {
      throw e
    }
  }
}

const sendCheckSessionMessage = async (sessionID: string): Promise<boolean> => {
  return await asyncSendMessage({
    query: 'checkSession',
    sessionID,
  })
}

const switchToSession = (sessionID: string) => {
  // window.history.pushState('', '', `#${sessionID}`)
  console.log({ sessionID })
}

const getPotentialSessionID = (): string | undefined => {
  const hash = window.location.hash.substring(1)
  return hash === '' ? undefined : hash
}

const getOrCreateSessionID = async () => {
  let sessionID
  const potentialSessionID = getPotentialSessionID() ?? ''

  if (potentialSessionID) {
    const sessionExists = await sendCheckSessionMessage(potentialSessionID)

    if (sessionExists) {
      sessionID = potentialSessionID
    }
  }

  if (!sessionID) {
    sessionID = await registerNewSession()
  }

  return sessionID
}

type SkipEvents = { [key in keyof HTMLMediaElementEventMap]: boolean }

const setupVideoEventHandlers = (port: Port, video: HTMLVideoElement) => {
  const playLike = ['play'] as Array<keyof HTMLMediaElementEventMap>
  const pauseLike = ['pause'] as Array<keyof HTMLMediaElementEventMap>
  const seekLike = ['seeking'] as Array<keyof HTMLMediaElementEventMap>

  const skipEvents = [...playLike, ...pauseLike, ...seekLike].reduce((skipEvents, eventName) => (
    {
      ...skipEvents,
      [eventName]: false,
    }
  ), {} as SkipEvents)

  const registerEvent = (eventType: string, eventName: keyof typeof skipEvents) => {
    const listener = () => {
      if (!skipEvents[eventName]) {
        console.log(`Sending ${eventName} event`)
        const videoTime = video.currentTime
        port.postMessage({
          query: 'videoEvent',
          payload: {
            type: eventType,
            data: { videoTime },
          },
        })
      } else {
        console.info(`Skipping ${eventName} event`)
        skipEvents[eventName] = false
      }
    }
    video?.addEventListener(eventName, listener)

    return () => video?.removeEventListener(eventName, listener)
  }

  const playEventRemovers = playLike.map(eventName =>
    registerEvent('playLikeEvent', eventName),
  )

  const pauseEventRemovers = pauseLike.map(eventName =>
    registerEvent('pauseLikeEvent', eventName),
  )

  const seekEventRemovers = seekLike.map(eventName =>
    registerEvent('seekLikeEvent', eventName),
  )

  const removeEventListeners = () => {
    [...playEventRemovers, ...pauseEventRemovers, ...seekEventRemovers].forEach(remover => remover())
  }

  return { skipEvents, removeEventListeners }
}

const getDisneyPlusPlayPauseElement = () => document.querySelector<HTMLButtonElement>(
  'div > div > div.controls__footer.display-flex > div.controls__footer__wrapper.display-flex >' +
  ' div.controls__center > button.control-icon-btn.play-icon.play-pause-icon',
)

const play = (video: HTMLVideoElement) => {
  console.log('playing')
  const disneyPlusPlayPauseButton = getDisneyPlusPlayPauseElement()
  if (disneyPlusPlayPauseButton) {
    disneyPlusPlayPauseButton.click()
  } else {
    video.play()
  }
}

const pause = (video: HTMLVideoElement) => {
  console.log('pausing')
  const disneyPlusPlayPauseButton = getDisneyPlusPlayPauseElement()
  if (disneyPlusPlayPauseButton) {
    disneyPlusPlayPauseButton.click()
  } else {
    video.pause()
  }
}

const setNewVideoTimeIfNecessary = (video: HTMLVideoElement, newVideoTime?: number) => {
  if (
    typeof newVideoTime === 'number' &&
    Math.abs(video.currentTime - newVideoTime) > acceptableTimeDifferenceBetweenClientsInMS
  ) {
    video.currentTime = newVideoTime
  }
}

const skipEvents = (skipEvents: SkipEvents, ...eventNames: Array<keyof SkipEvents>): void => {
  const keys = Object.keys(skipEvents) as Array<keyof SkipEvents>
  keys.forEach(key => {
    skipEvents[key] = false
  })

  eventNames.forEach(eventName => {
    skipEvents[eventName] = true
  })
}

const onForeignVideoEvent = (video: HTMLVideoElement, shouldSkipEvents: SkipEvents, message: any) => {
  if (Date.now() >= lastEventTime + eventCoolDown || true) {
    lastEventTime = Date.now()
    const videoTime: number | undefined = message?.data?.videoTime

    if (video) {
      switch (message.type) {
        case 'playLikeEvent':
          skipEvents(shouldSkipEvents, 'seeking', 'play')
          setNewVideoTimeIfNecessary(video, videoTime)
          play(video)
          console.info('play', message)
          break
        case 'pauseLikeEvent':
          skipEvents(shouldSkipEvents, 'seeking', 'pause')
          setNewVideoTimeIfNecessary(video, videoTime)
          pause(video)
          console.info('pause', message)
          break
        case 'seekLikeEvent':
          skipEvents(shouldSkipEvents, 'seeking')
          setNewVideoTimeIfNecessary(video, videoTime)
          console.info('seek', message)
          break
        default:
          console.info(message)
      }
    } else {
      console.warn('no video found!')
    }
  } else {
    console.log(`${message.type} event blocked by cool-down`)
  }
}


const sendSetupSocketMessage = async (sessionID: string, video: HTMLVideoElement) => {
  const port = chrome.runtime.connect({ name: 'stream-together' })

  port.postMessage({
    query: 'setupSocket',
    sessionID,
  })

  const { skipEvents, removeEventListeners } = setupVideoEventHandlers(port, video)

  port.onDisconnect.addListener(() => {
    console.log('Port disconnected; removing event listeners')
    removeEventListeners()
  })

  port.onMessage.addListener((message) => {
    onForeignVideoEvent(video, skipEvents, message)
  })
}

const initializePlugin = async () => {
  const videoElements = document.querySelectorAll('video')

  if (videoElements.length >= 1) {
    console.log('setting up plugin')
    const chosenVideo = videoElements[0]
    const sessionID = await getOrCreateSessionID()
    await switchToSession(sessionID)

    await sendSetupSocketMessage(sessionID, chosenVideo)
    return true
  } else {
    return false
  }
}

/**
 * Observes DOM and looks for first video. As soon as a video element is found, the plugin is initialized.
 */
const initializeForFirstVideo = () => {
  const obsRef: { current?: MutationObserver } = { current: undefined }

  obsRef.current = new MutationObserver(() => {
    const firstVideo = document.querySelector('video')

    if (firstVideo) {
      obsRef.current?.disconnect()

      // If session ID is already set, initialize plugin immediately. Otherwise,
      // wait for user to interact with video
      const potentialSessionID = getPotentialSessionID()
      if (potentialSessionID === undefined) {
        initializePlugin().catch(console.error)
      } else {
        firstVideo.addEventListener('play', () => {
          initializePlugin().catch(console.error)
        }, { once: true })
      }
    }
  })

  obsRef.current?.observe(document.documentElement, {
    attributes: false,
    attributeOldValue: false,
    characterData: false,
    characterDataOldValue: false,
    childList: true,
    subtree: true,
  })
}

initializeForFirstVideo()
