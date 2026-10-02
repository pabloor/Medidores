#pragma once
#include "PluginProcessor.h"

// Curva de respuesta en frecuencia, calculada a partir de los parámetros actuales.
class ResponseCurve : public juce::Component, private juce::Timer
{
public:
    explicit ResponseCurve (MedidoresEQAudioProcessor& p) : proc (p) { startTimerHz (20); }
    void paint (juce::Graphics&) override;

private:
    void timerCallback() override { repaint(); }
    MedidoresEQAudioProcessor& proc;
};

class MedidoresEQAudioProcessorEditor : public juce::AudioProcessorEditor
{
public:
    explicit MedidoresEQAudioProcessorEditor (MedidoresEQAudioProcessor&);
    void paint (juce::Graphics&) override;
    void resized() override;

private:
    using Attachment = juce::AudioProcessorValueTreeState::SliderAttachment;

    struct Knob
    {
        juce::Slider slider { juce::Slider::RotaryHorizontalVerticalDrag, juce::Slider::TextBoxBelow };
        juce::Label label;
        std::unique_ptr<Attachment> attachment;
    };

    void addKnob (Knob& k, const juce::String& paramId, const juce::String& text, const juce::String& suffix);

    MedidoresEQAudioProcessor& proc;
    ResponseCurve curve;
    Knob knobs[EQ::NumBands][3];   // [banda][0=frecuencia, 1=ganancia, 2=Q]
    Knob outKnob;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MedidoresEQAudioProcessorEditor)
};
