import matplotlib.pyplot as plt
import matplotlib.patches as patches
from model.note import Note
from model.sheet_music import SheetMusic, TimeSignature, KeySignature, NoteEvent, Duration


#This was going to be used to create a sheet music but it not quite ready for use

class SheetMusicVisualizer:
    def __init__(self, sheet_music: SheetMusic):
        self.sheet_music = sheet_music
        self.note_positions = {'C': 0, 'D': 1, 'E': 2, 'F': 3, 'G': 4, 'A': 5, 'B': 6}

    def _get_y_position(self, note: Note) -> int:
        base_name = note.name.replace('#', '').replace('b', '')
        octave_offset = (note.octave - 4) * 7
        return self.note_positions.get(base_name, 0) + octave_offset

    def _draw_staff(self, ax, start_x: float, end_x: float):
        # Treble clef lines correspond to E4(2), G4(4), B4(6), D5(8), F5(10)
        for y in [2, 4, 6, 8, 10]:
            ax.hlines(y, start_x, end_x, colors='black', linewidth=1)

    def visualize(self):
        fig, ax = plt.subplots(figsize=(12, 4))
        ax.set_title(f"{self.sheet_music.title} - {self.sheet_music.composer}", fontsize=16, fontweight='bold')
        
        track = self.sheet_music.tracks[0]
        
        current_x = 0.0
        measure_width = track.measures[0].time_signature.measure_duration if track.measures[0].time_signature else self.sheet_music.time_signature.measure_duration
        
        #Draw the staff across the whole piece
        total_width = len(track.measures) * measure_width + 1
        self._draw_staff(ax, 0, total_width)
        
        #Iterate through measures and draw notes
        for measure in track.measures:
            #  barline
            ax.vlines(current_x, 2, 10, colors='black', linewidth=1.5)
            
            for beat in measure.beats:
                event = beat.event
                x_pos = current_x + beat.position
                
                if isinstance(event, NoteEvent):
                    if event.is_rest:
                        #Draw a simple rest symbol (a rectangle for this demo)
                        ax.text(x_pos, 6, 'rest', fontsize=8, color='gray', ha='center')
                    else:
                        y_pos = self._get_y_position(event.note)
                        
                        #Draw the note head
                        note_head = patches.Ellipse((x_pos, y_pos), width=0.15, height=0.8, color='black')
                        ax.add_patch(note_head)
                        
                        #Draw the stem (stem points up if below B4 (y=6), down otherwise)
                        stem_direction = 1 if y_pos < 6 else -1
                        stem_end_y = y_pos + (3.5 * stem_direction)
                        
                        #Whole notes don't get stems, half notes get hollow heads (simplified here to just adjust colors)
                        if event.duration.value >= 0.5:
                            note_head.set_facecolor('white')
                            note_head.set_edgecolor('black')
                            note_head.set_linewidth(1.5)
                        
                        if event.duration.value < 1.0: # Add stem if not a whole note
                            stem_x = x_pos + (0.075 if stem_direction == 1 else -0.075)
                            ax.vlines(stem_x, y_pos, stem_end_y, colors='black', linewidth=1.5)
                            
                        #Add accidental if present
                        if '#' in event.note.name:
                            ax.text(x_pos - 0.15, y_pos, '#', fontsize=12, ha='right', va='center')
                        
                        #Draw ledger lines if the note falls outside the staff
                        if y_pos <= 0: # C4 or below
                            for ledger_y in range(0, y_pos - 1, -2):
                                ax.hlines(ledger_y, x_pos - 0.15, x_pos + 0.15, colors='black', linewidth=1.5)
                        elif y_pos >= 12: # A5 or above
                            for ledger_y in range(12, y_pos + 1, 2):
                                ax.hlines(ledger_y, x_pos - 0.15, x_pos + 0.15, colors='black', linewidth=1.5)

            #Move X coordinate to the start of the next measure
            current_x += measure_width
            
        #Draw final barline
        ax.vlines(current_x, 2, 10, colors='black', linewidth=3)
        ax.vlines(current_x - 0.1, 2, 10, colors='black', linewidth=1)

        #Formatting the plot
        ax.set_xlim(-0.5, total_width)
        ax.set_ylim(-4, 16)
        ax.axis('off')  #Hide standard plot axes
        
        plt.tight_layout()
        plt.savefig("sheet_music_output.png", dpi=300)
        print("Visualization saved successfully to 'sheet_music_output.png'")

#Test
if __name__ == "__main__":
    score = SheetMusic(
        title="Testing",
        composer="Seaghan",
        time_signature=TimeSignature(4, 4),
        key_signature=KeySignature.C_MAJOR
    )
    melody = score.add_track(name="Melody")

    m1 = melody.add_measure()
    m1.add_event(NoteEvent(note=Note("C", 4), duration=Duration.QUARTER))
    m1.add_event(NoteEvent(note=Note("D", 4), duration=Duration.QUARTER))
    m1.add_event(NoteEvent(note=Note("E", 4), duration=Duration.QUARTER))
    m1.add_event(NoteEvent(note=Note("F", 4), duration=Duration.QUARTER))
    m2 = melody.add_measure()
    m2.add_event(NoteEvent(note=Note("G", 4), duration=Duration.HALF))
    m2.add_event(NoteEvent(note=None,         duration=Duration.QUARTER)) #Rest
    m2.add_event(NoteEvent(note=Note("A#", 4), duration=Duration.QUARTER)) #Testing a sharp
    m3 = melody.add_measure()
    m3.add_event(NoteEvent(note=Note("C", 5), duration=Duration.WHOLE))
    viz = SheetMusicVisualizer(score)
    viz.visualize()