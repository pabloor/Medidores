#include "PluginEditor.h"

void ResponseCurve::paint (juce::Graphics& g)
{
    auto area = getLocalBounds().toFloat();
    g.setColour (juce::Colour (0xff15181d));
    g.fillRoundedRectangle (area, 6.0f);

    const float minDb = -24.0f, maxDb = 24.0f;
    auto xForFreq = [&] (float f) { return area.getX() + area.getWidth() * std::log (f / 20.0f) / std::log (1000.0f); };
    auto yForDb   = [&] (float d) { return area.getBottom() - area.getHeight() * (d - minDb) / (maxDb - minDb); };

    // Rejilla
    g.setColour (juce::Colours::white.withAlpha (0.08f));
    for (float f : { 50.f, 100.f, 200.f, 500.f, 1000.f, 2000.f, 5000.f, 10000.f })
        g.drawVerticalLine ((int) xForFreq (f), area.getY(), area.getBottom());
    for (float d : { -18.f, -12.f, -6.f, 6.f, 12.f, 18.f })
        g.drawHorizontalLine ((int) yForDb (d), area.getX(), area.getRight());
    g.setColour (juce::Colours::white.withAlpha (0.25f));
    g.drawHorizontalLine ((int) yForDb (0.0f), area.getX(), area.getRight());

    // Respuesta total = producto de las bandas
    const double sr = proc.getSampleRate() > 0 ? proc.getSampleRate() : 44100.0;
    EQ::Coeffs::Ptr coeffs[EQ::NumBands];
    for (int b = 0; b < EQ::NumBands; ++b) coeffs[b] = EQ::makeCoeffs (b, proc.apvts, sr);

    juce::Path path;
    const int w = juce::jmax (2, (int) area.getWidth());
    for (int i = 0; i < w; ++i)
    {
        const double f = 20.0 * std::pow (1000.0, (double) i / (w - 1));
        double mag = 1.0;
        for (auto& c : coeffs) mag *= c->getMagnitudeForFrequency (f, sr);
        const float db = juce::jlimit (minDb, maxDb, juce::Decibels::gainToDecibels ((float) mag, -60.0f));
        const float x = area.getX() + (float) i, y = yForDb (db);
        if (i == 0) path.startNewSubPath (x, y); else path.lineTo (x, y);
    }
    g.setColour (juce::Colour (0xff4fc3f7));
    g.strokePath (path, juce::PathStrokeType (2.0f));
}

MedidoresEQAudioProcessorEditor::MedidoresEQAudioProcessorEditor (MedidoresEQAudioProcessor& p)
    : AudioProcessorEditor (&p), proc (p), curve (p)
{
    addAndMakeVisible (curve);

    for (int b = 0; b < EQ::NumBands; ++b)
    {
        addKnob (knobs[b][0], EQ::freqId (b), "Frec", " Hz");
        if (b != EQ::HighPass) addKnob (knobs[b][1], EQ::gainId (b), "Gan", " dB");
        addKnob (knobs[b][2], EQ::qId (b), "Q", "");
    }
    addKnob (outKnob, EQ::outId, "Salida", " dB");

    setSize (640, 460);
}

void MedidoresEQAudioProcessorEditor::addKnob (Knob& k, const juce::String& id, const juce::String& text, const juce::String& suffix)
{
    k.slider.setTextValueSuffix (suffix);
    k.slider.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 70, 18);
    k.label.setText (text, juce::dontSendNotification);
    k.label.setJustificationType (juce::Justification::centred);
    k.attachment = std::make_unique<Attachment> (proc.apvts, id, k.slider);
    addAndMakeVisible (k.slider);
    addAndMakeVisible (k.label);
}

void MedidoresEQAudioProcessorEditor::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colour (0xff22262c));
    g.setColour (juce::Colours::white);
    g.setFont (juce::FontOptions (13.0f, juce::Font::bold));

    const int colW = (getWidth() - 20) / (EQ::NumBands + 1);
    for (int b = 0; b < EQ::NumBands; ++b)
        g.drawText (EQ::bands[b].name, 10 + b * colW, 200, colW, 18, juce::Justification::centred);
    g.drawText ("Salida", 10 + EQ::NumBands * colW, 200, colW, 18, juce::Justification::centred);
}

void MedidoresEQAudioProcessorEditor::resized()
{
    auto area = getLocalBounds().reduced (10);
    curve.setBounds (area.removeFromTop (180));
    area.removeFromTop (22);

    const int colW = area.getWidth() / (EQ::NumBands + 1);
    const int rowH = area.getHeight() / 3;

    auto place = [] (Knob& k, juce::Rectangle<int> r)
    {
        k.label.setBounds (r.removeFromTop (16));
        k.slider.setBounds (r);
    };

    for (int b = 0; b < EQ::NumBands; ++b)
        for (int row = 0; row < 3; ++row)
            if (! (b == EQ::HighPass && row == 1))
                place (knobs[b][row], { area.getX() + b * colW, area.getY() + row * rowH, colW, rowH });

    place (outKnob, { area.getX() + EQ::NumBands * colW, area.getY(), colW, rowH });
}
