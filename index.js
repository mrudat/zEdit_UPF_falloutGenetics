/* global fh, info, patcherUrl, patcherPath, registerPatcher, xelib */

const assert = require('assert').strict
const crypto = require('crypto')

const {
  jetpack,
  loadJsonFile
} = fh

const {
  AddElement,
  EditorID,
  GetElement,
  GetElements,
  GetFlag,
  GetFloatValue,
  GetGlobal,
  GetIntValue,
  GetIsFemale,
  GetIsUnique,
  GetLinksTo,
  GetRecord,
  GetValue,
  GetWinningOverride,
  gmFO4,
  HasElement,
  LongName,
  RemoveElement,
  SetFloatValue,
  SetIntValue,
  SetLinksTo,
  SetValue,
  WithHandle,
  WithHandles
} = xelib

// from https://en.wikipedia.org/wiki/SRGB
function sRGBtoRGB (u) {
  u = u / 255.0
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4
}
function RGBtosRGB (u) {
  u = u <= 0.0031308 ? u * 12.92 : (1.055 * (u ** (1 / 2.4))) - 0.055
  return Math.floor(u * 255.0)
}

function setLinksTo (element, path, target) {
  WithHandle(AddElement(element, path), (handle) => SetLinksTo(handle, target, ''))
}

function _parseIntColor (value) {
  return {
    red: sRGBtoRGB(value & 0xff),
    green: sRGBtoRGB((value >>> 8) & 0xff),
    blue: sRGBtoRGB((value >>> 16) & 0xff)
  }
}

function parseColor (colorString, logMessage) {
  switch (typeof colorString) {
    case 'number':
      return _parseIntColor(colorString)
    case 'string': {
      const firstChar = colorString.charAt(0)
      if (firstChar === 'r') {
        const temp = colorString.split('(', 2)
        if (temp[0] === 'rgba') {
          const rgba = temp[1].split(',')
          return {
            red: sRGBtoRGB(parseInt(rgba[0])),
            green: sRGBtoRGB(parseInt(rgba[1])),
            blue: sRGBtoRGB(parseInt(rgba[2])),
            alpha: parseInt(rgba[3])
          }
        } if (temp[0] === 'rgb') {
          const rgb = temp[1].split(',')
          return {
            red: sRGBtoRGB(parseInt(rgb[0])),
            green: sRGBtoRGB(parseInt(rgb[1])),
            blue: sRGBtoRGB(parseInt(rgb[2]))
          }
        }
      } else if (colorString.match(/#[0-9A-Fa-f]{6}/)) {
        return _parseIntColor(parseInt(colorString.slice(1), 16))
      } else if (colorString.match(/\d+/)) {
        return _parseIntColor(parseInt(colorString, 16))
      }
    }
  }
  logMessage(`[WARN] Not sure how to parse the color ${colorString}`)
  return false
}

function Random (edid, seed) {
  const edidbuf = Buffer.alloc(255 + 4)

  const edidLength = edid.length

  edidbuf.writeUInt32BE(seed, 0)
  edidbuf.write(edid, 4, edidLength)

  const tempbuf = edidbuf.slice(0, edidLength + 4)

  const outbuf = crypto.createHash('md5').update(tempbuf).digest()

  // state must be non-zero
  let state = outbuf.readUInt32BE(0) || 1

  return function (modulus) {
    // from https://en.wikipedia.org/wiki/Xorshift
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state = state >>> 0 // state is once more uint32.
    if (modulus) return state % modulus
    return state
  }
}

function randomf (random) {
  return (random() & 65535) / 65535.0
}

// gaussian random variable for genetics
// uses central limit theorem for generating from uniform random
function grandom (random) {
  let rand = 0
  for (let i = 0; i < 10; i += 1) {
    rand += randomf(random)
  }
  return rand / 10.0
}

// BEST method to check if there is a property in an object
// works for all kinds of weird things
function hasOwnProperty (obj, prop) {
  const proto = obj.constructor.prototype
  return (prop in obj) && (!(prop in proto) || proto[prop] !== obj[prop])
}

function pickOne (arr, random, func) {
  const length = arr.length
  if (!length) return
  func(arr[random(length)])
}

function pickN (arr, count, random, func) {
  const choices = []
  const maxrand = arr.length - count
  if (maxrand <= 0) { // choosing as many or more items than are present
    arr.forEach((choice) => func(choice))
    return
  }
  for (; count > 0; count--) {
    choices.push(random(maxrand))
  }
  choices.sort((a, b) => a - b)
  choices.forEach((choice, i) => func(arr[choice + i]))
}

function isCharGen (npc) {
  GetFlag(npc, 'ACBS\\Flags', 'Is CharGen Face Preset')
}

function convolve (parent1, parent2, defaultValue, func) {
  const child = {}
  for (const key in parent1) {
    if (hasOwnProperty(parent2, key)) {
      child[key] = func(key, parent1[key], parent2[key])
    } else {
      child[key] = func(key, parent1[key], defaultValue)
    }
  }
  for (const key in parent2) {
    if (hasOwnProperty(child, key)) continue
    child[key] = func(key, defaultValue, parent2[key])
  }
  return child
}

// required because some newly created arrays already have a [0].
function arrayPath () {
  let firstPath = true
  return () => {
    if (firstPath) {
      firstPath = false
      return '[0]'
    } else {
      return '.'
    }
  }
}

const defaultFemaleHDPTNames = new Set([
  'FemaleEyesHumanAO "FemaleEyesHumanAO" [HDPT:000F159E]',
  'FemaleEyesHumanLashes "FemaleEyesHumanLashes" [HDPT:0004D0EC]',
  'FemaleEyesHumanWet "FemaleEyesHumanWet" [HDPT:0014EC22]',
  'FemaleHeadHuman "FemaleHeadHuman" [HDPT:000CFB3F]',
  'FemaleHeadHumanRearTEMP "FemaleHeadHumanRearTEMP" [HDPT:0004D0E9]',
  'FemaleMouthHumanoidDefault "FemaleMouthHumanoidDefault" [HDPT:000CFB4E]'
])

const defaultMaleHDPTNames = new Set([
  'MaleEyesHumanAO "MaleEyesHumanAO" [HDPT:000844A7]',
  'MaleEyesHumanLashes "MaleEyesHumanLashes" [HDPT:000423AF]',
  'MaleEyesHumanWet "MaleEyesHumanWet" [HDPT:0011CCBD]',
  'MaleHeadHuman "MaleHeadHuman" [HDPT:0001EEBB]',
  'MaleHeadHumanRearTEMP "MaleHeadHumanRearTEMP" [HDPT:0001F735]',
  'MaleMouthHumanoidDefault "MaleMouthHumanoidDefault" [HDPT:00051631]'
])

const HDPTRaces = {
  'HeadPartsHumanGhouls [FLST:001125DF]': true,
  'HeadPartsHuman [FLST:000A8026]': true
}

const requiredHeadPartTypes = [
  'Eyes',
  'Hair'
]

const femaleHeadPartTypes = [
  'Eyes',
  'Hair'
]

const maleHeadPartTypes = [
  'Eyes',
  'Hair',
  'Facial Hair'
]

const FMRSFields = [
  'Position - X',
  'Position - Y',
  'Position - Z',
  'Rotation - X',
  'Rotation - Y',
  'Rotation - Z',
  'Scale'
]

const MRSVFields = [
  'Head',
  'Upper Torso',
  'Arms',
  'Lower Torso',
  'Legs'
]

const FEMALE_HDPT_FLAG = 4
const MALE_HDPT_FLAG = 2

const RAIDER_FACTION = 'RaiderFaction "Raiders" [FACT:0001CBED]'
const SETTLER_FACTION = 'WorkshopNPCFaction [FACT:000337F3]'
const COA_FACTION = 'ChildrenOfAtomFaction [FACT:0002FB84]'

registerPatcher({
  info: info,
  gameModes: [gmFO4],
  settings: {
    label: 'Fallout Genetics Patcher',
    templateUrl: `${patcherUrl}/partials/settings.html`,
    defaultSettings: {
      patchFileName: 'zPatch.esp',
      ignoreCharGen: true,
      useMorphs: true,
      seed: 42,
      beardChance: 5,
      applyFoundation: true,
      applyMakeup: false,
      paleLipstickColor: 139,
      darkLipstickColor: 4916319
    }
  },
  execute: (patchFile, helpers, settings, locals) => ({
    initialize: function () {
      const { logMessage } = helpers

      locals.paleLipstickColor = parseColor(settings.paleLipstickColor)
      locals.darkLipstickColor = parseColor(settings.darkLipstickColor)

      const femaleData = locals.femaleData = {}
      const maleData = locals.maleData = {}
      const neutralHDPTs = {}

      for (const type of femaleHeadPartTypes) {
        femaleData[type] = []
      }
      for (const type of maleHeadPartTypes) {
        maleData[type] = []
        neutralHDPTs[type] = []
      }

      const defaultFemaleHDPTs = locals.defaultFemaleHDPTs = []
      const defaultMaleHDPTs = locals.defaultMaleHDPTs = []

      for (const hdpt of helpers.loadRecords('HDPT')) {
        const longName = LongName(hdpt)
        if (defaultFemaleHDPTNames.has(longName)) {
          defaultFemaleHDPTs.push(hdpt)
          continue
        }
        if (defaultMaleHDPTNames.has(longName)) {
          defaultMaleHDPTs.push(hdpt)
          continue
        }
        if (!HDPTRaces[GetValue(hdpt, 'RNAM')]) continue
        const ptype = GetValue(hdpt, 'PNAM')
        let data = null
        switch (GetIntValue(hdpt, 'DATA') & (FEMALE_HDPT_FLAG | MALE_HDPT_FLAG)) {
          case FEMALE_HDPT_FLAG:
            data = femaleData[ptype]
            break
          case MALE_HDPT_FLAG:
            data = maleData[ptype]
            break
          case FEMALE_HDPT_FLAG | MALE_HDPT_FLAG:
          case 0: // neither
            data = neutralHDPTs[ptype]
        }
        if (data) data.push(hdpt)
      }

      for (const type of maleHeadPartTypes) {
        const hdpts = neutralHDPTs[type]
        maleData[type].push(...hdpts)
        if (type === 'Facial Hair') continue
        femaleData[type].push(...hdpts)
      }

      for (const type of requiredHeadPartTypes) {
        assert.ok(femaleData[type].length > 0, `Couldn't find any ${type}!`)
        assert.ok(maleData[type].length > 0, `Couldn't find any ${type}!`)
      }

      const femaleHairColors = femaleData.hairColors = []
      const maleHairColors = maleData.hairColors = []
      const neutralHairColors = []

      const fallout4Esm = GetElement(0, 'Fallout4.esm')
      const humanRace = GetWinningOverride(GetElement(fallout4Esm, 'RACE\\HumanRace'))

      for (const color of GetElements(humanRace, 'Female Hair Colors')) {
        femaleHairColors.push(GetLinksTo(color))
      }
      for (const color of GetElements(humanRace, 'Male Hair Colors')) {
        maleHairColors.push(GetLinksTo(color))
      }

      const dataDir = jetpack.cwd(GetGlobal('DataPath'))

      const hairColorDir = dataDir.cwd('F4SE/Plugins/F4EE/LUTs')
      if (hairColorDir.exists('.')) {
        for (const modDir of hairColorDir.list()) {
          if (hairColorDir.exists(modDir) !== 'directory') continue
          const colorFile = GetElement(0, modDir)
          if (colorFile === 0) continue
          const CLFMs = GetElement(colorFile, 'CLFM')
          if (CLFMs === 0) continue
          const patchDir = hairColorDir.cwd(modDir)
          if (patchDir.exists('HairColors.json') !== 'file') continue
          const hairColorData = loadJsonFile(patchDir.path('HairColors.json'), {})
          if (!Array.isArray(hairColorData.Colors)) continue
          for (const color in hairColorData.Colors) {
            const { Form, Races, Gender } = color // LUT unused
            let forHuman = false
            for (const race in Races) {
              if (race === 'HumanRace') forHuman = true
            }
            if (!forHuman) continue
            const clfm = GetWinningOverride(GetRecord(colorFile, parseInt(Form)))
            switch (Gender) {
              case 1:
                femaleHairColors.push(clfm)
                break
              case 2:
                maleHairColors.push(clfm)
                break
              case 3:
              default:
                neutralHairColors.push(clfm)
                break
            }
          }
        }

        femaleHairColors.push(...neutralHairColors)
        maleHairColors.push(...neutralHairColors)
      }

      const femaleTintLayers = femaleData.tints = new Map()
      const maleTintLayers = maleData.tints = new Map()
      const foo = [
        [femaleTintLayers, 'Female Tint Layers'],
        [maleTintLayers, 'Male Tint Layers']
      ]
      for (const [data, key] of foo) {
        for (const group of GetElements(humanRace, key)) {
          const groupName = GetValue(group, 'TTGP')
          for (const option of GetElements(group, 'Options')) {
            const optionData = {}
            const teti = GetElement(option, 'TETI')
            const slotIndex = GetValue(teti, 'Index')
            const optionName = GetValue(option, 'TTGP')
            optionData.index = `${slotIndex} ${groupName} - ${optionName}`
            if (HasElement(option, 'TTEC')) {
              const colors = optionData.colors = []
              for (const templateColor of GetElements(option, 'TTEC')) {
                const clfm = GetLinksTo(templateColor, 'Color')
                const alpha = GetFloatValue(templateColor, 'Alpha')
                const index = GetValue(templateColor, 'Index')
                const colorValue = GetValue(clfm, 'CNAM')
                const color = parseColor(colorValue)
                if (!color) continue
                colors.push({
                  color: color,
                  alpha: alpha,
                  index: index
                })
              }
            }

            let target = 'unknown'

            switch (groupName) {
              case 'FaceRegions':
                target = 'Junk'
                break
              case 'SkinTints':
                target = 'Skin'
                break
              case 'Brows':
                target = 'Eyebrows'
                break
              case 'Makeup': // Female only.
                target = 'Makeup'
                switch (optionName) {
                  case 'Lipstick':
                    target = 'Lipstick'
                    break
                  case 'Lip Liner':
                    target = 'Junk'
                    break
                  case 'Lip Gloss':
                  case 'Lip Matte':
                    target = 'Lips'
                }
                break
              case 'Blemishes':
                target = 'Blemishes'
                if (optionName.startsWith('Lip')) target = 'Junk'
                break
              case 'Markings':
                if (optionName.startsWith('Freckles')) target = 'Freckles'
                if (optionName.startsWith('Moles')) target = 'Moles'
                break
              case 'Grime':
                target = 'Dirt'
                break
              case 'Face Paint':
                target = 'Raiders'
                if (HasElement(option, 'Conditions')) {
                  for (const condition of GetElements(option, 'Conditions')) {
                    if (GetValue(condition, 'CTDA\\Function') === 'GetGlobalValue') {
                      if (EditorID(GetLinksTo(condition, 'CTDA\\Global')) === 'AtomFacePaints') {
                        target = 'ChildrenOfAtom'
                      }
                    }
                  }
                }
                break
              case 'Face Tattoos':
                target = 'Raiders'
                break
              case 'Damage':
                if (optionName.startsWith('Boxer')) target = 'Bruising'
                if (optionName.startsWith('Scar')) target = 'Scars'
                break
            }

            if (target === 'Junk') continue

            if (target === 'unknown') {
              logMessage(`Not sure what to do with tink mask: ${groupName}/${optionName}`)
            }

            if (!data[target]) data[target] = []
            data[target].push(optionData)
          }
        }
        assert.ok(data.Eyebrows.length > 1, 'No eyebrows found!')
      }

      if (settings.useMorphs) {
        const presetPath = jetpack.cwd(patcherPath).cwd('presets')
        assert.ok(presetPath.exists('.') === 'dir', 'Could not find presets directory, reinstall?')

        const fPresets = femaleData.presets = []
        const mPresets = maleData.presets = []

        for (const file of presetPath.list()) {
          if (!file.endsWith('.json')) continue
          if (presetPath.exists(file) !== 'file') continue
          const preset = loadJsonFile(presetPath.path(file), {})
          const morphs = preset.Morphs
          if (!morphs) continue
          if (parseInt(preset.Gender) === 1) {
            fPresets.push(morphs)
          } else {
            mPresets.push(morphs)
          }
        }
        logMessage(`Found ${fPresets.length} female presets and ${mPresets.length} male presets.`)
      }
    },
    process: [{
      load: {
        signature: 'NPC_',
        filter: function (npc) {
          if (settings.ignoreCharGen && isCharGen(npc)) return false
          if (GetValue(npc, 'RNAM') !== 'HumanRace "Human" [RACE:00013746]') return false
          return true
        }
      },
      patch: function (npc, helpers, settings, locals) {
        const { logMessage } = helpers
        logMessage(`Changing appearance of ${LongName(npc)}`)
        const { femaleData, maleData, defaultFemaleHDPTs, defaultMaleHDPTs } = locals
        const random = Random(EditorID(npc), settings.seed)
        const isFemale = GetIsFemale(npc)
        const data = isFemale ? femaleData : maleData

        const headPartPath = arrayPath()
        RemoveElement(npc, 'Head Parts')
        WithHandle(AddElement(npc, 'Head Parts'), (headParts) => {
          // const headParts = AddElement(npc, 'Head Parts')
          const addHeadPart = (headPart) => setLinksTo(headParts, headPartPath(), headPart)

          const defaultHDPTs = isFemale ? defaultFemaleHDPTs : defaultMaleHDPTs
          defaultHDPTs.forEach(addHeadPart)
          for (const type of requiredHeadPartTypes) {
            pickOne(data[type], random, addHeadPart)
          }
          if (!isFemale) {
            if (random(100) <= settings.beardChance) {
              pickOne(maleData['Facial Hair'], random, addHeadPart)
            }
          }
        })

        pickOne(data.hairColors, random, (color) => setLinksTo(npc, 'HCLF', color))
        RemoveElement(npc, 'BCLF')

        const morphData = data.presets
        const morphDataLength = morphData.length
        if (settings.useMorphs && morphDataLength >= 2) {
          // pick two different entries.
          const i1 = random(morphDataLength)
          let i2 = random(morphDataLength - 1)
          if (i2 >= i1) i2 = i2 + 1
          const parent1 = morphData[i1]
          const parent2 = morphData[i2]
          const weight = grandom(random)

          const w = (value1, value2) => weight * (value1 || 0) + (1 - weight) * (value2 || 0)

          RemoveElement(npc, 'Face Morphs')
          WithHandle(AddElement(npc, 'Face Morphs'), (faceMorphs) => {
            const faceMorphPath = arrayPath()
            convolve(
              parent1.Regions,
              parent2.Regions,
              [0, 0, 0, 0, 0, 0, 0],
              (morphIndex, value1, value2) => {
                WithHandle(AddElement(faceMorphs, faceMorphPath()), (faceMorph) => {
                  // FIXME validate that morphIndex is valid for gender?
                  // TODO find matching morphIndex for opposite gender?
                  SetValue(faceMorph, 'FMRI', morphIndex)
                  WithHandle(AddElement(faceMorph, 'FMRS'), (values) => {
                    FMRSFields.forEach((fieldName, index) => {
                      SetFloatValue(values, fieldName, w(value1[index], value2[index]))
                    })
                  })
                })
              }
            )
          })

          RemoveElement(npc, 'MSDK')
          RemoveElement(npc, 'MSDV')
          WithHandles(
            [AddElement(npc, 'MSDK'), AddElement(npc, 'MSDV')],
            ([MSDK, MSDV]) => {
              convolve(
                parent1.Presets,
                parent2.Presets,
                0,
                (key, value1, value2) => {
                  WithHandles(
                    [AddElement(MSDK, '.'), AddElement(MSDV, '.')],
                    ([msdk, msdv]) => {
                      SetValue(msdk, key)
                      SetFloatValue(msdv, w(value1, value2))
                    }
                  )
                }
              )
            }
          )

          WithHandle(AddElement(npc, 'MRSV'), (mrsv) => {
            const value1 = parent1.Values || []
            const value2 = parent2.Values || []
            MRSVFields.forEach((fieldName, index) => {
              SetFloatValue(mrsv, fieldName, w(value1[index], value2[index]))
            })
          })

          RemoveElement(npc, 'FMIN')
        }

        if (!GetIsUnique(npc)) {
          const tintData = data.tints
          const baseTints = []
          // stuff hidden by concealer
          let concealer = false
          const blemishTints = []
          const scarTints = []
          const surfaceTints = []

          let lightness = 0
          var skinRed, skinGreen, skinBlue
          {
            const skin = tintData.Skin[0]
            const skinColor = []
            pickN(skin.colors, 2, random, (data) => {
              skinColor.push(data)
            })
            let weight = randomf(random)
            if (weight <= 0.5) {
              weight = 1 - weight
              skinColor.reverse()
            }
            const w = (value1, value2) => weight * value1 + (1 - weight) * value2
            const [skinColor1, skinColor2] = skinColor
            const color1 = skinColor1.color
            const color2 = skinColor2.color
            skinRed = w(color1.red, color2.red)
            skinGreen = w(color1.green, color2.green)
            skinBlue = w(color1.blue, color2.blue)
            lightness = 0.2126 * skinRed + 0.7152 * skinGreen + 0.0722 * skinBlue
            baseTints.push({
              type: 'Value/Color',
              index: skin.index,
              templateColor: skinColor1.index,
              value: w(skinColor1.alpha, skinColor2.alpha),
              red: RGBtosRGB(skinRed),
              green: RGBtosRGB(skinGreen),
              blue: RGBtosRGB(skinBlue)
            })
          }

          pickOne(tintData.Eyebrows, random, (data) => {
            baseTints.push({
              type: 'Value',
              index: data.index,
              value: 1
            })
          })

          pickN(tintData.Blemishes, random(5), random, (data) => {
            blemishTints.push({
              type: 'Value',
              index: data.index,
              value: 0.05 + (randomf(random) * 0.2)
            })
          })

          // 25% chance for a completely white person to have freckles
          if (randomf(random) * lightness >= 0.25) {
            tintData.Freckles.forEach((data) => {
              blemishTints.push({
                type: 'Value',
                index: data.index,
                value: randomf(random) * (1 - lightness)
              })
            })
          } else {
            // 10% with no freckles get 1-2 moles.
            if (randomf(random) <= 0.1) {
              pickN(tintData.Moles, random(2) + 1, random, (data) => {
                blemishTints.push({
                  type: 'Value',
                  index: data.index,
                  value: 0.05 + (randomf(random) * 0.2)
                })
              })
            }
          }

          const factions = new Set()
          if (HasElement(npc, 'Factions')) {
            WithHandles(GetElements(npc, 'Factions'), (factionArray) => {
              for (const faction of factionArray) {
                factions.add(GetValue(faction, 'Faction'))
              }
            })
          }

          if (isFemale && factions.has(SETTLER_FACTION)) {
            if (settings.applyFoundation) {
              concealer = true
              if (settings.applyMakeup) {
                {
                  const lipstick = tintData.Lipstick[0]

                  const w = (value1, value2) => lightness * value1 + (1 - lightness) * value2

                  const paleColor = locals.paleLipstickColor
                  const darkColor = locals.darkLipstickColor

                  surfaceTints.push({
                    type: 'Value/Color',
                    index: lipstick.index,
                    templateColor: -1,
                    value: 1.0,
                    red: RGBtosRGB(w(paleColor.red, darkColor.red)),
                    green: RGBtosRGB(w(paleColor.green, darkColor.green)),
                    blue: RGBtosRGB(w(paleColor.blue, darkColor.blue))
                  })
                }

                // Lip Gloss/Matte
                pickOne(tintData.Lips, random, (data) => {
                  surfaceTints.push({
                    type: 'Value',
                    index: data.index,
                    value: randomf(random)
                  })
                })
                // TODO Eyeliner 1 - black.
                // TODO eye shadow dependent on eye color
              }
            }
          }

          if (!factions.has(SETTLER_FACTION)) {
            pickN(tintData.Dirt, random(3) + 1, random, (data) => {
              surfaceTints.push({
                type: 'Value/Color',
                index: data.index,
                templateColor: -1,
                value: 0.05 + randomf(random) * 0.2,
                red: RGBtosRGB(randomf(random)),
                green: RGBtosRGB(randomf(random)),
                blue: RGBtosRGB(randomf(random))
              })
            })
          }

          if (factions.has(SETTLER_FACTION)) {
            pickOne(tintData.Scars, random, (data) => {
              scarTints.push({
                type: 'Value',
                index: data.index,
                value: 0.05 + (randomf(random) * 0.2)
              })
            })
          } else {
            pickN(tintData.Scars, random, random(5) + 1, (data) => {
              scarTints.push({
                type: 'Value',
                index: data.index,
                value: 0.2 + (randomf(random) * 0.5)
              })
            })
          }

          if (factions.has(RAIDER_FACTION)) {
            pickOne(tintData.Raiders, random, (data) => {
              surfaceTints.push({
                type: 'Value',
                index: data.index,
                value: 1.0
              })
            })
          }

          if (factions.has(COA_FACTION)) {
            pickOne(tintData.ChildrenOfAtom, random, (data) => {
              surfaceTints.push({
                type: 'Value',
                index: data.index,
                value: 0.25 + (randomf(random) * 0.5)
              })
            })
          }
          // TODO Bruising - using melee weapons?

          RemoveElement(npc, 'Face Tinting Layers')
          WithHandle(AddElement(npc, 'Face Tinting Layers'), (faceTints) => {
            const layerPath = arrayPath()

            const applyTint = (tint) => {
              WithHandle(AddElement(faceTints, layerPath()), (layer) => {
                WithHandles(
                  [GetElement(layer, 'TETI'), GetElement(layer, 'TEND')],
                  ([teti, tend]) => {
                    SetValue(teti, 'Data Type', tint.type)
                    SetValue(teti, 'Index', tint.index)
                    // displayed as a float, stored as an integer percentage
                    SetIntValue(tend, 'Value', tint.value * 100)
                    if (tint.type === 'Value/Color') {
                      SetIntValue(tend, 'Template Color Index', tint.templateColor)
                      WithHandle(GetElement(tend, 'Color'), (color) => {
                        SetIntValue(color, 'Red', tint.red)
                        SetIntValue(color, 'Green', tint.green)
                        SetIntValue(color, 'Blue', tint.blue)
                      })
                    }
                  }
                )
              })
            }

            baseTints.forEach(applyTint)
            if (concealer) {
              // don't apply blemishes
              // minimise scars
              scarTints.forEach((tint) => {
                tint.value = tint.value / 4
                applyTint(tint)
              })
            } else {
              blemishTints.forEach(applyTint)
              scarTints.forEach(applyTint)
            }
            surfaceTints.forEach(applyTint)
          })
        }
      }
    }]
  })
})
