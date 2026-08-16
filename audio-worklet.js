/* global AudioWorkletProcessor, registerProcessor, sampleRate */

function floatTo16BitPCM(samples) {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] || 0));
    output[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return output;
}

function resampleLinear(samples, inputRate, outputRate, phase = 0) {
  if (!samples?.length || inputRate <= 0 || outputRate <= 0) {
    return { samples: new Float32Array(), phase };
  }
  if (inputRate === outputRate) {
    return { samples: Float32Array.from(samples), phase: 0 };
  }
  const ratio = inputRate / outputRate;
  const values = [];
  let position = phase;
  while (position < samples.length) {
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const weight = position - left;
    values.push(samples[left] * (1 - weight) + samples[right] * weight);
    position += ratio;
  }
  return {
    samples: Float32Array.from(values),
    phase: position - samples.length,
  };
}

if (typeof AudioWorkletProcessor !== "undefined") {
  class CaptionPcmProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.phase = 0;
      this.pending = [];
    }

    process(inputs) {
      const channel = inputs?.[0]?.[0];
      if (!channel?.length) return true;
      const converted = resampleLinear(channel, sampleRate, 16_000, this.phase);
      this.phase = converted.phase;
      for (const value of converted.samples) this.pending.push(value);
      if (this.pending.length >= 1600) {
        const chunk = this.pending.splice(0, 1600);
        const pcm = floatTo16BitPCM(chunk);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
      return true;
    }
  }

  registerProcessor("caption-pcm-processor", CaptionPcmProcessor);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { floatTo16BitPCM, resampleLinear };
}
