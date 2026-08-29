export {
  DEFAULT_MEDIA_LIMITS,
  MEDIA_KIND,
  evaluateMediaLimits,
  mediaAssetFingerprint,
  mergeMediaLimits,
  normalizeMediaAsset,
} from './media.js';

export {
  createDeterministicMultimodalAdapter,
  createMultimodalPipeline,
} from './pipeline.js';

export {
  createCompositeVideoAdapter,
  createOpenAiCompatibleAudioAdapter,
  createOpenAiCompatibleVisionAdapter,
} from './adapters/openai-compatible.js';

export {
  BrowserMediaCaptureError,
  DEFAULT_BROWSER_CAPTURE_LIMITS,
  InMemoryMediaHandleStore,
  createBrowserMediaCapture,
  createBrowserMediaCaptureService,
  createMediaCapture,
  createMediaHandleStore,
} from './browser-capture.js';
