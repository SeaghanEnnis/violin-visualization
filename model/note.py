class Note:
    # Standard letters
    # Starts from C
    CHROMATIC_SCALE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    
    def __init__(self, name: str, octave: int):
        """
        Initializes a musical note.
        :param name: The note letter (e.g., 'C', 'A#', 'Gb')
        :param octave: The octave number (e.g., 4 for middle C's octave)
        """
        self.name = self._normalize_name(name)
        self.octave = octave

    def _normalize_name(self, name: str) -> str:
        #Converts flats to sharps for standardizing
        name = name.strip().capitalize()
        #Flat to Sharp conversions
        flat_map = {'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#'}
        return flat_map.get(name, name)

    @property
    def midi_number(self) -> int:
        """Calculates the MIDI note number (where C-1 is 0, and C4 is 60)."""
        if self.name not in self.CHROMATIC_SCALE:
            raise ValueError(self._invalid_note_error())
            
        semitone_index = self.CHROMATIC_SCALE.index(self.name)
        # C4 is MIDI 60. Formula: (octave + 1) * 12 + semitone_index
        return (self.octave + 1) * 12 + semitone_index

    @property
    def frequency(self) -> float:
        # Frequency formula: f = 440 * 2^((d - 69) / 12)
        #A4 = 440 Hz (MIDI 69).
        return round(440.0 * (2.0 ** ((self.midi_number - 69) / 12.0)), 2)

    def __add__(self, semitones: int) -> 'Note':
        #Adds a semitone (halfnote)
        if not isinstance(semitones, int):
            raise TypeError("Can only add integer semitones to a Note.")
        
        total_semitones = self.midi_number + semitones
        return Note.from_midi(total_semitones)

    def __sub__(self, semitones: int) -> 'Note':
        #Subtracts a semitone (halfnote)
        return self.__add__(-semitones)

    @classmethod
    def from_midi(cls, midi_number: int) -> 'Note':
        #coverts a note from the MIDI 
        octave = (midi_number // 12) - 1
        semitone_index = midi_number % 12
        name = cls.CHROMATIC_SCALE[semitone_index]
        return cls(name, octave)

    def _invalid_note_error(self) -> str:
        #TODO typed error ?
        return f"Invalid note name '{self.name}'. Must be one of {self.CHROMATIC_SCALE} (or flat equivalents)."

    def __repr__(self) -> str:
        return f"Note('{self.name}', {self.octave})"

    def __str__(self) -> str:
        return f"{self.name}{self.octave}"