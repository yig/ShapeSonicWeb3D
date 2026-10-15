Make a 3D implementation of ShapeSonic that works in the browser. Use `../webhands` for hand-tracking with world-space coordinates. The paper describing ShapeSonic is ``../paper/main.tex`. A 3D implementation for iOS is in `../demo-iOS`. It uses ARKit to position fingers in world-space on the iPhone screen. A 2D implementation for the web is in `../demo`. The sounds are in the `../demo/audio` directory.

UI:

* A pop-up menu on the screen should let the user choose from demo shapes (`models/*.obj`) or load a 3D shape (as an OBJ and possibly other formats). That should be enough to rasterize an SDF. (Consider an octree SDF to limit memory consumption.) Detect corners and edges from the OBJ.

* A toggle to show the shape. By default the shape should be hidden. (Its name should only be visible inside the pop-up menu.) Visualize detected corners and edges.

Save and maintain a document describing the implementation's design and architecture.
